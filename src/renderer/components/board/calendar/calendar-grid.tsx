import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  GUTTER_WIDTH,
  TOTAL_SLOTS,
  formatTimeRange,
  formatHour,
  groupOverlapping,
  isSameDay,
  resolveNowY,
  resolveHourHeight,
  resolveTimelineViewportHeight,
  slotRangeFromDates,
  slotRangeToDates,
  snapToSlot,
  type SlotRange,
} from "@/lib/calendar-utils";
import {
  buildAllDaySegments,
  packAllDaySegments,
  resolveAllDaySpanDays,
} from "@/lib/calendar-all-day-utils";
import {
  SHIFT_SCROLL_IDLE_SETTLE_DELAY_MS,
  SHIFT_SCROLL_SETTLE_ANIMATION_MS,
  normalizeShiftWheelDelta,
  resolveShiftScrollBufferDays,
  resolveShiftScrollSettleDays,
  scaleShiftWheelDelta,
} from "@/lib/calendar-shift-scroll";
import { columnStyles } from "@/lib/status-presentation";
import { CalendarEventBlock } from "./calendar-event-block";
import { CalendarInlineCreator } from "./calendar-inline-creator";
import { OccurrenceScopeDialog } from "./occurrence-scope-dialog";
import type { DatabasePage as PageType, OccurrenceEditScope } from "@/lib/types";
import { ARCHIVED_CARD_OPTION_ID } from "@/lib/board-options";
import {
  applyPreviewToScheduledEvents,
  areCalendarEventPreviewsEqual,
  createCalendarEventPreview,
  resolveCalendarEventInteraction,
  resolveMovePreviewOverlayEvent,
  type CalendarEventInteractionMode,
  type CalendarEventPreviewState,
} from "./calendar-event-interaction";
import {
  resolveCalendarMoveDropSchedule,
  resolveCalendarMovePreview,
  type CalendarMoveDragSession,
  type CalendarMoveDropTarget,
} from "./calendar-event-move-drag";
import {
  readRetainedScrollPosition,
  useRetainedScrollPosition,
} from "@/lib/retained-scroll-position";

interface ScheduledPage extends Omit<PageType, "scheduledStart" | "scheduledEnd"> {
  pageId?: string;
  columnId: string;
  columnName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  occurrenceStart?: Date;
  occurrenceEnd?: Date;
  isRecurring?: boolean;
  thisAndFutureEquivalentToAll?: boolean;
}
type GroupedScheduledPage = ScheduledPage & { lane: number; totalLanes: number };

interface DragState {
  dayIndex: number;
  startSlot: number;
  endSlot: number;
}

interface CreatorState {
  dayIndex: number;
  startSlot: number;
  endSlot: number;
}

interface EventInteractionState {
  pointerId: number;
  eventId: string;
  pageId: string;
  occurrenceStart: Date;
  columnId: string;
  mode: Exclude<CalendarEventInteractionMode, "move">;
  originDayIndex: number;
  originRange: SlotRange;
  pointerStartX: number;
  pointerStartY: number;
  started: boolean;
}

interface AllDayMovePreview {
  eventId: string;
  startDayIndex: number;
  endDayIndex: number;
}

interface ActiveMoveDragState extends CalendarMoveDragSession {
  pageId: string;
  occurrenceStart: Date;
  columnId: string;
  accentColor: string;
  defaultScheduleLabel: string;
}

interface MoveDragGhost {
  element: HTMLDivElement;
  content: HTMLDivElement;
  scheduleNode: HTMLDivElement;
}

interface PendingScopedUpdate {
  columnId: string;
  pageId: string;
  occurrenceStart: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  isAllDay: boolean;
  eventTitle: string;
  fromLabel: string;
  toLabel: string;
  thisAndFutureEquivalentToAll: boolean;
}

interface CalendarGridProps {
  visibleDays: Date[];
  createRequestId: number;
  scheduledPages: ScheduledPage[];
  showPageKey?: boolean;
  pageStagePageId: string | undefined;
  onClickPage: (page: ScheduledPage) => void;
  onCreatePage: (title: string, start: Date, end: Date) => void;
  onCompleteOccurrence: (pageId: string, occurrenceStart: Date) => void;
  onSkipOccurrence: (pageId: string, occurrenceStart: Date) => void;
  onUpdatePageSchedule: (
    columnId: string,
    pageId: string,
    occurrenceStart: Date,
    scheduledStart: Date,
    scheduledEnd: Date,
    isAllDay?: boolean,
    scope?: "this" | "this-and-future" | "all",
  ) => void | Promise<void>;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
  allDayLaneHeight: number;
  onAllDayLaneHeightChange: (height: number) => void;
  scrollStateKey?: string | null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DEFAULT_CREATE_SLOTS = 2; // 30 minutes
const DROP_PREVIEW_TIMEOUT_MS = 2000;
const ALL_DAY_EVENT_HEIGHT = 24;
const ALL_DAY_EVENT_GAP = 4;
const ALL_DAY_LANE_MIN_HEIGHT = 40;
const ALL_DAY_LANE_MAX_HEIGHT = 220;
const ALL_DAY_SEPARATOR_HEIGHT = 1;
const MIN_LARGE_RANGE_DAY_COLUMN_WIDTH = 104;
type EventInteractionFinishReason = "pointer-up" | "pointer-cancel" | "lost-pointer-capture";
type MoveDropRegion = "timed" | "all-day" | "outside";
const CALENDAR_EVENT_DRAG_MIME = "application/x-nodex-calendar-event";

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatScheduleLabel(start: Date, end: Date, isAllDay: boolean = false): string {
  const dayLabel = start.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (isAllDay) {
    const spanDays = resolveAllDaySpanDays(start, end);
    if (spanDays <= 1) return `${dayLabel}, All day`;
    const endLabel = new Date(end);
    endLabel.setDate(endLabel.getDate() - 1);
    return `${dayLabel} - ${endLabel.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, All day`;
  }
  return `${dayLabel}, ${formatTimeRange(start, end)}`;
}

function createHiddenCalendarEventDragImage(): HTMLDivElement {
  const ghost = document.createElement("div");
  ghost.style.position = "fixed";
  ghost.style.top = "-9999px";
  ghost.style.left = "-9999px";
  ghost.style.width = "1px";
  ghost.style.height = "1px";
  ghost.style.opacity = "0";
  ghost.style.pointerEvents = "none";
  document.body.appendChild(ghost);
  return ghost;
}

function createCalendarMoveDragGhost({
  title,
  accentColor,
  scheduleLabel,
}: {
  title: string;
  accentColor: string;
  scheduleLabel: string;
}): MoveDragGhost {
  const ghost = document.createElement("div");
  ghost.style.position = "fixed";
  ghost.style.top = "0";
  ghost.style.left = "0";
  ghost.style.maxWidth = "280px";
  ghost.style.pointerEvents = "none";
  ghost.style.transform = "translate3d(-9999px, -9999px, 0)";
  ghost.style.willChange = "transform";
  ghost.style.zIndex = "9999";

  const content = document.createElement("div");
  content.style.padding = "6px 10px";
  content.style.borderRadius = "8px";
  content.style.borderLeft = `3px solid ${accentColor}`;
  content.style.border = `1px solid color-mix(in srgb, ${accentColor} 28%, transparent)`;
  content.style.background = `color-mix(in srgb, ${accentColor} 14%, var(--background))`;
  content.style.color = "var(--foreground)";
  content.style.boxShadow = "0 10px 24px rgba(0, 0, 0, 0.18)";
  content.style.fontSize = "12px";
  content.style.lineHeight = "1.3";
  content.style.fontWeight = "600";
  content.style.opacity = "0";
  content.style.transformOrigin = "top left";
  content.style.transform = "scale(0.96)";
  content.style.transition =
    "opacity 120ms ease, transform 120ms ease, background-color 120ms ease";
  content.style.willChange = "opacity, transform";

  const titleNode = document.createElement("div");
  titleNode.textContent = title;
  titleNode.style.whiteSpace = "nowrap";
  titleNode.style.overflow = "hidden";
  titleNode.style.textOverflow = "ellipsis";

  const scheduleNode = document.createElement("div");
  scheduleNode.textContent = scheduleLabel;
  scheduleNode.style.marginTop = "2px";
  scheduleNode.style.fontSize = "10px";
  scheduleNode.style.fontWeight = "500";
  scheduleNode.style.opacity = "0.8";

  content.appendChild(titleNode);
  content.appendChild(scheduleNode);
  ghost.appendChild(content);
  document.body.appendChild(ghost);

  return {
    element: ghost,
    content,
    scheduleNode,
  };
}

function formatAllDayDragGhostScheduleLabel(day: Date, spanDays: number): string {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + Math.max(1, spanDays));
  return formatScheduleLabel(start, end, true);
}

function hasCalendarEventDragMime(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(CALENDAR_EVENT_DRAG_MIME);
}

export function CalendarGrid({
  visibleDays,
  createRequestId,
  scheduledPages,
  showPageKey = true,
  pageStagePageId,
  onClickPage,
  onCreatePage,
  onCompleteOccurrence,
  onSkipOccurrence,
  onUpdatePageSchedule,
  onNavigatePrev,
  onNavigateNext,
  allDayLaneHeight,
  onAllDayLaneHeightChange,
  scrollStateKey,
}: CalendarGridProps) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [creatorState, setCreatorState] = useState<CreatorState | null>(null);
  const [eventPreview, setEventPreview] = useState<CalendarEventPreviewState | null>(null);
  const [activeMoveDragEventId, setActiveMoveDragEventId] = useState<string | null>(null);
  const [allDayMovePreview, setAllDayMovePreview] = useState<AllDayMovePreview | null>(null);
  const [moveDropRegion, setMoveDropRegion] = useState<MoveDropRegion | null>(null);
  const [pendingScopedUpdate, setPendingScopedUpdate] = useState<PendingScopedUpdate | null>(null);
  const [scopeDialogBusy, setScopeDialogBusy] = useState(false);
  const [timelineViewportHeight, setTimelineViewportHeight] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const isDragging = useRef(false);
  const eventInteractionRef = useRef<EventInteractionState | null>(null);
  const activeMoveDragRef = useRef<ActiveMoveDragState | null>(null);
  const moveDragGhostRef = useRef<MoveDragGhost | null>(null);
  const completedMoveDropRef = useRef<{ eventId: string; preserveTimedPreview: boolean } | null>(
    null,
  );
  const suppressOpenRef = useRef<{ eventId: string; until: number } | null>(null);
  const eventPreviewRef = useRef<CalendarEventPreviewState | null>(null);
  const pendingDropPreviewEventIdRef = useRef<string | null>(null);
  const pendingDropPreviewTimeoutRef = useRef<number | null>(null);
  const handledCreateRequestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const scrollInitRef = useRef(false);
  const shiftWheelAccumulatedPxRef = useRef(0);
  const shiftWheelSettleTimeoutRef = useRef<number | null>(null);
  const shiftWheelSettleRafRef = useRef<number | null>(null);
  const visualOffsetPxRef = useRef(0);
  const dayColWidthRef = useRef(0);
  const [visualOffsetPx, setVisualOffsetPx] = useState(0);
  const [visualBufferDays, setVisualBufferDays] = useState(1);
  const retainedScroll = useRetainedScrollPosition<HTMLDivElement>(scrollStateKey ?? null, {
    axis: "vertical",
    retryFrames: 2,
  });
  const retainedScrollRef = retainedScroll.ref;

  const setEventPreviewSynced = useCallback((nextPreview: CalendarEventPreviewState | null) => {
    eventPreviewRef.current = nextPreview;
    setEventPreview(nextPreview);
  }, []);

  const clearMoveDragGhost = useCallback(() => {
    const dragGhost = moveDragGhostRef.current;
    if (!dragGhost) return;
    dragGhost.element.remove();
    moveDragGhostRef.current = null;
  }, []);

  const clearPendingDropPreview = useCallback(
    (eventId?: string) => {
      const pendingEventId = pendingDropPreviewEventIdRef.current;
      if (!pendingEventId) return;
      if (eventId && pendingEventId !== eventId) return;

      pendingDropPreviewEventIdRef.current = null;
      if (pendingDropPreviewTimeoutRef.current !== null) {
        window.clearTimeout(pendingDropPreviewTimeoutRef.current);
        pendingDropPreviewTimeoutRef.current = null;
      }

      const currentPreview = eventPreviewRef.current;
      if (!currentPreview || currentPreview.eventId !== pendingEventId) return;
      setEventPreviewSynced(null);
    },
    [setEventPreviewSynced],
  );

  const armPendingDropPreview = useCallback(
    (eventId: string) => {
      pendingDropPreviewEventIdRef.current = eventId;
      if (pendingDropPreviewTimeoutRef.current !== null) {
        window.clearTimeout(pendingDropPreviewTimeoutRef.current);
      }

      pendingDropPreviewTimeoutRef.current = window.setTimeout(() => {
        clearPendingDropPreview(eventId);
      }, DROP_PREVIEW_TIMEOUT_MS);
    },
    [clearPendingDropPreview],
  );

  useEffect(() => {
    eventPreviewRef.current = eventPreview;
  }, [eventPreview]);

  // Cancel delayed shift+wheel navigation on unmount.
  useEffect(() => {
    return () => {
      if (shiftWheelSettleTimeoutRef.current !== null) {
        window.clearTimeout(shiftWheelSettleTimeoutRef.current);
        shiftWheelSettleTimeoutRef.current = null;
      }
      if (shiftWheelSettleRafRef.current !== null) {
        cancelAnimationFrame(shiftWheelSettleRafRef.current);
        shiftWheelSettleRafRef.current = null;
      }
      if (pendingDropPreviewTimeoutRef.current !== null) {
        window.clearTimeout(pendingDropPreviewTimeoutRef.current);
        pendingDropPreviewTimeoutRef.current = null;
      }
      clearMoveDragGhost();
    };
  }, [clearMoveDragGhost]);

  const updateLayoutMetrics = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const nextPanelHeight = container.clientHeight;
    const headerHeight = headerRef.current?.offsetHeight ?? 0;
    const allDayLaneHeight = allDayRef.current?.offsetHeight ?? 0;
    const nextTimelineHeight = resolveTimelineViewportHeight({
      panelHeight: nextPanelHeight,
      headerHeight,
      allDayLaneHeight,
      separatorHeight: ALL_DAY_SEPARATOR_HEIGHT,
    });

    setTimelineViewportHeight(nextTimelineHeight);
    setContainerWidth(container.clientWidth);
  }, []);

  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      retainedScrollRef(node);
      scrollRef.current = node;
      if (!node) return;
      updateLayoutMetrics();
    },
    [retainedScrollRef, updateLayoutMetrics],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver(() => {
      updateLayoutMetrics();
    });

    resizeObserver.observe(container);

    const header = headerRef.current;
    if (header) {
      resizeObserver.observe(header);
    }

    const allDayLane = allDayRef.current;
    if (allDayLane) {
      resizeObserver.observe(allDayLane);
    }

    updateLayoutMetrics();

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateLayoutMetrics]);

  const hourHeight = resolveHourHeight(timelineViewportHeight ?? Number.NaN);
  const slotHeight = hourHeight / 4;

  const rawDayColWidth =
    containerWidth > 0 && visibleDays.length > 0
      ? (containerWidth - GUTTER_WIDTH) / visibleDays.length
      : 0;
  const dayColWidth =
    visibleDays.length > 7
      ? Math.max(rawDayColWidth, MIN_LARGE_RANGE_DAY_COLUMN_WIDTH)
      : rawDayColWidth;
  const calendarContentWidth =
    dayColWidth > 0 ? GUTTER_WIDTH + dayColWidth * visibleDays.length : undefined;

  useLayoutEffect(() => {
    dayColWidthRef.current = dayColWidth;
  }, [dayColWidth]);

  const setVisualOffset = useCallback((nextOffsetPx: number) => {
    visualOffsetPxRef.current = nextOffsetPx;
    setVisualOffsetPx(nextOffsetPx);
  }, []);

  const resetShiftWheelVisualState = useCallback(() => {
    shiftWheelAccumulatedPxRef.current = 0;
    visualOffsetPxRef.current = 0;
    setVisualOffsetPx(0);
    setVisualBufferDays(1);
  }, []);

  useLayoutEffect(() => {
    if (shiftWheelSettleTimeoutRef.current !== null) {
      window.clearTimeout(shiftWheelSettleTimeoutRef.current);
      shiftWheelSettleTimeoutRef.current = null;
    }
    if (shiftWheelSettleRafRef.current !== null) {
      cancelAnimationFrame(shiftWheelSettleRafRef.current);
      shiftWheelSettleRafRef.current = null;
    }
    resetShiftWheelVisualState();
  }, [resetShiftWheelVisualState, visibleDays]);

  useEffect(() => {
    if (createRequestId <= 0) return;
    if (handledCreateRequestIdRef.current === createRequestId) return;
    if (visibleDays.length === 0) return;
    handledCreateRequestIdRef.current = createRequestId;

    const firstDay = visibleDays[0]!;
    const now = new Date();
    const roundedMinute = Math.ceil(now.getMinutes() / 15) * 15;
    const currentSlot = now.getHours() * 4 + Math.floor(roundedMinute / 15);
    const fallbackSlot = 9 * 4;
    const startSlot = Math.max(
      0,
      Math.min(isSameDay(firstDay, now) ? currentSlot : fallbackSlot, TOTAL_SLOTS - 4),
    );

    setDragState(null);
    setCreatorState({
      dayIndex: 0,
      startSlot,
      endSlot: startSlot + 3,
    });
  }, [createRequestId, visibleDays]);

  const pageById = useMemo(
    () => new Map(scheduledPages.map((page) => [page.id, page])),
    [scheduledPages],
  );

  const isMoveDragPreviewActiveNow = Boolean(
    activeMoveDragEventId && eventPreview && eventPreview.eventId === activeMoveDragEventId,
  );

  const previewedPages = useMemo(
    () =>
      applyPreviewToScheduledEvents(scheduledPages, eventPreview, visibleDays, {
        freezeLayout: isMoveDragPreviewActiveNow,
      }),
    [eventPreview, isMoveDragPreviewActiveNow, scheduledPages, visibleDays],
  );

  const movePreviewOverlay = useMemo(
    () =>
      resolveMovePreviewOverlayEvent(pageById, eventPreview, visibleDays, {
        isMovePreviewActive: isMoveDragPreviewActiveNow,
      }),
    [pageById, eventPreview, isMoveDragPreviewActiveNow, visibleDays],
  );

  const findDayIndex = useCallback(
    (date: Date) => visibleDays.findIndex((day) => isSameDay(day, date)),
    [visibleDays],
  );

  useEffect(() => {
    const pendingEventId = pendingDropPreviewEventIdRef.current;
    if (!pendingEventId) return;

    const preview = eventPreviewRef.current;
    if (!preview || preview.eventId !== pendingEventId) {
      clearPendingDropPreview(pendingEventId);
      return;
    }

    const page = scheduledPages.find((scheduledPage) => scheduledPage.id === pendingEventId);
    if (!page) return;

    const dayIndex = findDayIndex(page.scheduledStart);
    if (dayIndex !== preview.dayIndex) return;

    const range = slotRangeFromDates(page.scheduledStart, page.scheduledEnd);
    if (range.startSlot !== preview.range.startSlot || range.endSlot !== preview.range.endSlot) {
      return;
    }

    clearPendingDropPreview(pendingEventId);
  }, [clearPendingDropPreview, findDayIndex, scheduledPages]);

  const resolvePointerDropTarget = useCallback(
    (clientX: number, clientY: number): CalendarMoveDropTarget | null => {
      if (visibleDays.length === 0) return null;

      const resolveDayIndexFromRect = (rect: DOMRect): number | null => {
        const dayAreaLeft = rect.left + GUTTER_WIDTH;
        const dayAreaRight = rect.right;
        if (clientX < dayAreaLeft || clientX > dayAreaRight) return null;

        const dayAreaWidth = dayAreaRight - dayAreaLeft;
        if (dayAreaWidth <= 0) return null;
        const dayWidth = dayAreaWidth / visibleDays.length;
        const relativeX = clientX - dayAreaLeft + visualOffsetPxRef.current;
        return Math.max(0, Math.min(Math.floor(relativeX / dayWidth), visibleDays.length - 1));
      };

      const allDayNode = allDayRef.current;
      if (allDayNode) {
        const allDayRect = allDayNode.getBoundingClientRect();
        if (
          clientY >= allDayRect.top &&
          clientY <= allDayRect.bottom &&
          clientX >= allDayRect.left &&
          clientX <= allDayRect.right
        ) {
          const dayIndex = resolveDayIndexFromRect(allDayRect);
          if (dayIndex !== null) return { dayIndex, region: "all-day" };
        }
      }

      const gridBody = gridBodyRef.current;
      if (!gridBody) return null;
      const rect = gridBody.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) return null;
      const dayIndex = resolveDayIndexFromRect(rect);
      if (dayIndex === null) return null;
      const relativeY = clientY - rect.top;
      const slot = snapToSlot(relativeY, hourHeight);
      return { dayIndex, region: "timed", slot };
    },
    [hourHeight, visibleDays.length],
  );

  const resolvePointerGridPosition = useCallback(
    (clientX: number, clientY: number): { dayIndex: number; slot: number } | null => {
      const target = resolvePointerDropTarget(clientX, clientY);
      if (!target || target.region !== "timed" || target.slot === undefined) return null;
      return { dayIndex: target.dayIndex, slot: target.slot };
    },
    [resolvePointerDropTarget],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, dayIndex: number) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-calendar-event-block]")) return;
      if (eventInteractionRef.current) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const slot = snapToSlot(e.clientY - rect.top, hourHeight);

      e.currentTarget.setPointerCapture(e.pointerId);
      isDragging.current = true;
      setCreatorState(null);
      setDragState({ dayIndex, startSlot: slot, endSlot: slot });
    },
    [hourHeight],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, dayIndex: number) => {
      if (!isDragging.current || !dragState || dragState.dayIndex !== dayIndex) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const slot = snapToSlot(e.clientY - rect.top, hourHeight);
      if (slot === dragState.endSlot) return;

      setDragState((prev) => (prev ? { ...prev, endSlot: slot } : null));
    },
    [dragState, hourHeight],
  );

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>, dayIndex: number) => {
      if (!isDragging.current || !dragState || dragState.dayIndex !== dayIndex) return;
      isDragging.current = false;

      const minSlot = Math.min(dragState.startSlot, dragState.endSlot);
      const maxSlot = Math.max(dragState.startSlot, dragState.endSlot);

      const isClick = minSlot === maxSlot;
      const endSlot = isClick
        ? Math.min(minSlot + DEFAULT_CREATE_SLOTS - 1, TOTAL_SLOTS - 1)
        : maxSlot;

      setCreatorState({ dayIndex, startSlot: minSlot, endSlot });
      setDragState(null);
    },
    [dragState],
  );

  const handlePointerCancel = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setDragState(null);
  }, []);

  const startResizeInteraction = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      page: ScheduledPage,
      mode: EventInteractionState["mode"],
    ) => {
      if (event.button !== 0) return;

      const originDayIndex = findDayIndex(page.scheduledStart);
      if (originDayIndex < 0) return;

      const originRange = slotRangeFromDates(page.scheduledStart, page.scheduledEnd);

      event.currentTarget.setPointerCapture(event.pointerId);
      clearPendingDropPreview();

      eventInteractionRef.current = {
        pointerId: event.pointerId,
        eventId: page.id,
        pageId: page.pageId ?? page.id,
        occurrenceStart: page.occurrenceStart ?? page.scheduledStart,
        columnId: page.columnId,
        mode,
        originDayIndex,
        originRange,
        pointerStartX: event.clientX,
        pointerStartY: event.clientY,
        started: true,
      };

      setCreatorState(null);
      setDragState(null);
      setEventPreviewSynced(createCalendarEventPreview(page.id, originDayIndex, originRange));
    },
    [clearPendingDropPreview, findDayIndex, setEventPreviewSynced],
  );

  const updateEventInteraction = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const interaction = eventInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;

      const resolved = resolveCalendarEventInteraction({
        eventId: interaction.eventId,
        mode: interaction.mode,
        originDayIndex: interaction.originDayIndex,
        originRange: interaction.originRange,
        pointerStartX: interaction.pointerStartX,
        pointerStartY: interaction.pointerStartY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        activationDistance: 0,
        wasActivated: interaction.started,
        grabOffsetSlots: 0,
        gridPosition: resolvePointerGridPosition(event.clientX, event.clientY),
      });
      interaction.started = resolved.activated;
      if (!resolved.preview) return;

      if (!areCalendarEventPreviewsEqual(eventPreviewRef.current, resolved.preview)) {
        setEventPreviewSynced(resolved.preview);
      }

      if (event.cancelable) {
        event.preventDefault();
      }
    },
    [resolvePointerGridPosition, setEventPreviewSynced],
  );

  const finishEventInteraction = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      { canceled }: { canceled: boolean; reason: EventInteractionFinishReason },
    ) => {
      const interaction = eventInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      eventInteractionRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const page = pageById.get(interaction.eventId);
      const preview = eventPreviewRef.current;

      if (canceled || !page) {
        clearPendingDropPreview(interaction.eventId);
        setEventPreviewSynced(null);
        return;
      }

      const pointerResolved = resolveCalendarEventInteraction({
        eventId: interaction.eventId,
        mode: interaction.mode,
        originDayIndex: interaction.originDayIndex,
        originRange: interaction.originRange,
        pointerStartX: interaction.pointerStartX,
        pointerStartY: interaction.pointerStartY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        activationDistance: 0,
        wasActivated: interaction.started,
        grabOffsetSlots: 0,
        gridPosition: resolvePointerGridPosition(event.clientX, event.clientY),
      });
      interaction.started = pointerResolved.activated;

      const nextPreview =
        pointerResolved.preview ??
        (preview && preview.eventId === interaction.eventId ? preview : null) ??
        createCalendarEventPreview(
          interaction.eventId,
          interaction.originDayIndex,
          interaction.originRange,
        );

      const unchanged =
        nextPreview.dayIndex === interaction.originDayIndex &&
        nextPreview.range.startSlot === interaction.originRange.startSlot &&
        nextPreview.range.endSlot === interaction.originRange.endSlot;
      if (unchanged) {
        clearPendingDropPreview(interaction.eventId);
        setEventPreviewSynced(null);
        return;
      }

      const dayDate = visibleDays[nextPreview.dayIndex];
      if (!dayDate) {
        clearPendingDropPreview(interaction.eventId);
        setEventPreviewSynced(null);
        return;
      }

      const rangeDates = slotRangeToDates(dayDate, nextPreview.range);
      const isRecurringEvent = page.isRecurring || Boolean(page.recurrence);
      if (isRecurringEvent) {
        clearPendingDropPreview(interaction.eventId);
        setEventPreviewSynced(null);
        setPendingScopedUpdate({
          columnId: interaction.columnId,
          pageId: interaction.pageId,
          occurrenceStart: interaction.occurrenceStart,
          scheduledStart: rangeDates.start,
          scheduledEnd: rangeDates.end,
          isAllDay: false,
          eventTitle: page.title,
          fromLabel: formatScheduleLabel(
            page.scheduledStart,
            page.scheduledEnd,
            Boolean(page.isAllDay),
          ),
          toLabel: formatScheduleLabel(rangeDates.start, rangeDates.end),
          thisAndFutureEquivalentToAll: Boolean(page.thisAndFutureEquivalentToAll),
        });
        return;
      }

      setEventPreviewSynced(nextPreview);
      armPendingDropPreview(interaction.eventId);
      void onUpdatePageSchedule(
        interaction.columnId,
        interaction.pageId,
        interaction.occurrenceStart,
        rangeDates.start,
        rangeDates.end,
        false,
      );
    },
    [
      armPendingDropPreview,
      pageById,
      clearPendingDropPreview,
      onUpdatePageSchedule,
      resolvePointerGridPosition,
      setEventPreviewSynced,
      visibleDays,
    ],
  );

  const handlePageOpen = useCallback(
    (page: ScheduledPage) => {
      const suppress = suppressOpenRef.current;
      if (suppress && suppress.eventId === page.id && suppress.until > Date.now()) {
        return;
      }
      onClickPage(page);
    },
    [onClickPage],
  );

  const updateMoveDragPreview = useCallback(
    (target: CalendarMoveDropTarget | null) => {
      const drag = activeMoveDragRef.current;
      if (!drag) return;

      if (!target) {
        setMoveDropRegion("outside");
        setAllDayMovePreview(null);
        setEventPreviewSynced(null);
        return;
      }

      const preview = resolveCalendarMovePreview(drag, target);
      if (!preview) {
        setMoveDropRegion("outside");
        setAllDayMovePreview(null);
        setEventPreviewSynced(null);
        return;
      }

      if (preview.kind === "timed") {
        const nextPreview = createCalendarEventPreview(
          drag.eventId,
          preview.dayIndex,
          preview.range,
        );
        if (!areCalendarEventPreviewsEqual(eventPreviewRef.current, nextPreview)) {
          setEventPreviewSynced(nextPreview);
        }
        setAllDayMovePreview(null);
        setMoveDropRegion("timed");
        return;
      }

      setEventPreviewSynced(null);
      setAllDayMovePreview((current) => {
        if (
          current &&
          current.eventId === drag.eventId &&
          current.startDayIndex === preview.startDayIndex &&
          current.endDayIndex === preview.endDayIndex
        ) {
          return current;
        }
        return {
          eventId: drag.eventId,
          startDayIndex: preview.startDayIndex,
          endDayIndex: preview.endDayIndex,
        };
      });
      setMoveDropRegion("all-day");
    },
    [setEventPreviewSynced],
  );

  const commitMoveDrop = useCallback(
    (target: CalendarMoveDropTarget): boolean => {
      const drag = activeMoveDragRef.current;
      if (!drag) return false;

      const page = pageById.get(drag.eventId);
      if (!page) return false;

      const nextSchedule = resolveCalendarMoveDropSchedule(drag, target, visibleDays);
      if (!nextSchedule) return false;

      const unchanged = nextSchedule.isAllDay
        ? Boolean(page.isAllDay) &&
          isSameDay(page.scheduledStart, nextSchedule.start) &&
          resolveAllDaySpanDays(page.scheduledStart, page.scheduledEnd) ===
            resolveAllDaySpanDays(nextSchedule.start, nextSchedule.end)
        : !page.isAllDay &&
          page.scheduledStart.getTime() === nextSchedule.start.getTime() &&
          page.scheduledEnd.getTime() === nextSchedule.end.getTime();

      if (unchanged) return false;

      const isRecurringEvent = page.isRecurring || Boolean(page.recurrence);
      if (isRecurringEvent) {
        clearPendingDropPreview(drag.eventId);
        setEventPreviewSynced(null);
        setPendingScopedUpdate({
          columnId: drag.columnId,
          pageId: drag.pageId,
          occurrenceStart: drag.occurrenceStart,
          scheduledStart: nextSchedule.start,
          scheduledEnd: nextSchedule.end,
          isAllDay: nextSchedule.isAllDay,
          eventTitle: page.title,
          fromLabel: formatScheduleLabel(
            page.scheduledStart,
            page.scheduledEnd,
            Boolean(page.isAllDay),
          ),
          toLabel: formatScheduleLabel(nextSchedule.start, nextSchedule.end, nextSchedule.isAllDay),
          thisAndFutureEquivalentToAll: Boolean(page.thisAndFutureEquivalentToAll),
        });
        return false;
      }

      if (nextSchedule.isAllDay) {
        clearPendingDropPreview(drag.eventId);
        setEventPreviewSynced(null);
      } else {
        const preview = resolveCalendarMovePreview(drag, target);
        if (preview?.kind === "timed") {
          setEventPreviewSynced(
            createCalendarEventPreview(drag.eventId, preview.dayIndex, preview.range),
          );
        }
        armPendingDropPreview(drag.eventId);
      }

      void onUpdatePageSchedule(
        drag.columnId,
        drag.pageId,
        drag.occurrenceStart,
        nextSchedule.start,
        nextSchedule.end,
        nextSchedule.isAllDay,
      );

      return !nextSchedule.isAllDay;
    },
    [
      armPendingDropPreview,
      pageById,
      clearPendingDropPreview,
      onUpdatePageSchedule,
      setEventPreviewSynced,
      visibleDays,
    ],
  );

  const updateMoveDragGhost = useCallback(
    (target: CalendarMoveDropTarget | null, pointerX: number, pointerY: number) => {
      const drag = activeMoveDragRef.current;
      const dragGhost = moveDragGhostRef.current;
      if (!drag || !dragGhost) return;

      const shouldShow = target?.region === "all-day" && Boolean(visibleDays[target.dayIndex]);
      const nextX = Math.round(pointerX + 14);
      const nextY = Math.round(pointerY + 14);
      dragGhost.element.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;

      if (shouldShow && target) {
        const day = visibleDays[target.dayIndex];
        if (day) {
          dragGhost.scheduleNode.textContent = formatAllDayDragGhostScheduleLabel(
            day,
            drag.originalAllDaySpanDays,
          );
        }
        dragGhost.content.style.background = `color-mix(in srgb, ${drag.accentColor} 22%, var(--background))`;
        dragGhost.content.style.opacity = "1";
        dragGhost.content.style.transform = "scale(1)";
        return;
      }

      dragGhost.scheduleNode.textContent = drag.defaultScheduleLabel;
      dragGhost.content.style.background = `color-mix(in srgb, ${drag.accentColor} 14%, var(--background))`;
      dragGhost.content.style.opacity = "0";
      dragGhost.content.style.transform = "scale(0.96)";
    },
    [visibleDays],
  );

  const startMoveDrag = useCallback(
    (event: React.DragEvent<HTMLElement>, page: ScheduledPage) => {
      if (eventInteractionRef.current) return;

      const originDayIndex = findDayIndex(page.scheduledStart);
      if (originDayIndex < 0) return;

      const originRange = slotRangeFromDates(page.scheduledStart, page.scheduledEnd);
      const durationSlots = originRange.endSlot - originRange.startSlot + 1;
      const dropTarget = resolvePointerDropTarget(event.clientX, event.clientY);
      const pointerSlot = dropTarget?.region === "timed" ? dropTarget.slot : originRange.startSlot;
      const grabOffsetSlots = Math.max(
        0,
        Math.min(pointerSlot - originRange.startSlot, durationSlots - 1),
      );
      const accentColor = columnStyles[page.columnId]?.accentColor ?? "#8E8B86";
      const defaultScheduleLabel = formatScheduleLabel(
        page.scheduledStart,
        page.scheduledEnd,
        Boolean(page.isAllDay),
      );

      activeMoveDragRef.current = {
        eventId: page.id,
        pageId: page.pageId ?? page.id,
        occurrenceStart: page.occurrenceStart ?? page.scheduledStart,
        columnId: page.columnId,
        originDayIndex,
        originRange,
        originIsAllDay: Boolean(page.isAllDay),
        originalDurationMs: Math.max(
          60_000,
          page.scheduledEnd.getTime() - page.scheduledStart.getTime(),
        ),
        originalAllDaySpanDays: resolveAllDaySpanDays(page.scheduledStart, page.scheduledEnd),
        grabOffsetSlots,
        accentColor,
        defaultScheduleLabel,
      };

      completedMoveDropRef.current = null;
      suppressOpenRef.current = { eventId: page.id, until: Date.now() + 250 };
      clearPendingDropPreview();
      setCreatorState(null);
      setDragState(null);
      setEventPreviewSynced(null);
      setAllDayMovePreview(null);
      setMoveDropRegion(dropTarget?.region ?? "outside");
      setActiveMoveDragEventId(page.id);
      clearMoveDragGhost();
      moveDragGhostRef.current = createCalendarMoveDragGhost({
        title: page.title,
        accentColor,
        scheduleLabel: defaultScheduleLabel,
      });
      updateMoveDragGhost(dropTarget, event.clientX, event.clientY);

      const dragImage = createHiddenCalendarEventDragImage();

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(CALENDAR_EVENT_DRAG_MIME, page.id);
      event.dataTransfer.setData("text/plain", page.title);
      event.dataTransfer.setDragImage(dragImage, 0, 0);
      requestAnimationFrame(() => dragImage.remove());
    },
    [
      clearMoveDragGhost,
      clearPendingDropPreview,
      findDayIndex,
      resolvePointerDropTarget,
      setEventPreviewSynced,
      updateMoveDragGhost,
    ],
  );

  const endMoveDrag = useCallback(
    (pageId: string) => {
      const drag = activeMoveDragRef.current;
      if (!drag || drag.eventId !== pageId) return;

      const completed = completedMoveDropRef.current;
      const preserveTimedPreview =
        completed?.eventId === drag.eventId && completed.preserveTimedPreview;

      if (!preserveTimedPreview) {
        clearPendingDropPreview(drag.eventId);
        setEventPreviewSynced(null);
      }

      suppressOpenRef.current = { eventId: drag.eventId, until: Date.now() + 250 };
      activeMoveDragRef.current = null;
      clearMoveDragGhost();
      completedMoveDropRef.current = null;
      setActiveMoveDragEventId(null);
      setMoveDropRegion(null);
      setAllDayMovePreview(null);
    },
    [clearMoveDragGhost, clearPendingDropPreview, setEventPreviewSynced],
  );

  useEffect(() => {
    if (!activeMoveDragEventId) return;

    const onWindowDragOver = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer || !hasCalendarEventDragMime(dataTransfer)) return;
      const drag = activeMoveDragRef.current;
      if (!drag || drag.eventId !== activeMoveDragEventId) return;

      const target = resolvePointerDropTarget(event.clientX, event.clientY);
      updateMoveDragPreview(target);
      updateMoveDragGhost(target, event.clientX, event.clientY);

      if (target) {
        event.preventDefault();
        dataTransfer.dropEffect = "move";
      } else {
        dataTransfer.dropEffect = "none";
      }
    };

    const onWindowDrop = (event: DragEvent) => {
      if (!hasCalendarEventDragMime(event.dataTransfer)) return;
      const drag = activeMoveDragRef.current;
      if (!drag || drag.eventId !== activeMoveDragEventId) return;

      const target = resolvePointerDropTarget(event.clientX, event.clientY);
      if (!target) return;

      event.preventDefault();
      completedMoveDropRef.current = {
        eventId: drag.eventId,
        preserveTimedPreview: commitMoveDrop(target),
      };
    };

    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, [
    activeMoveDragEventId,
    commitMoveDrop,
    resolvePointerDropTarget,
    updateMoveDragGhost,
    updateMoveDragPreview,
  ]);

  const handleCreateCommit = useCallback(
    (title: string, start: Date, end: Date) => {
      onCreatePage(title, start, end);
      setCreatorState(null);
    },
    [onCreatePage],
  );

  const handleCreateCancel = useCallback(() => {
    setCreatorState(null);
  }, []);

  const handleScopeCancel = useCallback(() => {
    if (scopeDialogBusy) return;
    setPendingScopedUpdate(null);
  }, [scopeDialogBusy]);

  const handleScopeSelect = useCallback(
    async (scope: OccurrenceEditScope) => {
      const pending = pendingScopedUpdate;
      if (!pending || scopeDialogBusy) return;

      setScopeDialogBusy(true);
      try {
        const effectiveScope =
          pending.thisAndFutureEquivalentToAll && scope === "this-and-future" ? "all" : scope;
        await onUpdatePageSchedule(
          pending.columnId,
          pending.pageId,
          pending.occurrenceStart,
          pending.scheduledStart,
          pending.scheduledEnd,
          pending.isAllDay,
          effectiveScope,
        );
      } catch (error) {
        console.error("Failed to update recurring occurrence schedule", error);
      } finally {
        setScopeDialogBusy(false);
        setPendingScopedUpdate(null);
      }
    },
    [onUpdatePageSchedule, pendingScopedUpdate, scopeDialogBusy],
  );

  const clampAllDayLaneHeight = useCallback((height: number) => {
    return Math.max(ALL_DAY_LANE_MIN_HEIGHT, Math.min(ALL_DAY_LANE_MAX_HEIGHT, Math.round(height)));
  }, []);

  const handleAllDayResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const startY = event.clientY;
      const startHeight = allDayLaneHeight;
      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        onAllDayLaneHeightChange(clampAllDayLaneHeight(startHeight + delta));
      };
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [allDayLaneHeight, clampAllDayLaneHeight, onAllDayLaneHeightChange],
  );

  const handleAllDaySeparatorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        onAllDayLaneHeightChange(clampAllDayLaneHeight(allDayLaneHeight - 8));
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        onAllDayLaneHeightChange(clampAllDayLaneHeight(allDayLaneHeight + 8));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        onAllDayLaneHeightChange(ALL_DAY_LANE_MIN_HEIGHT);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onAllDayLaneHeightChange(ALL_DAY_LANE_MAX_HEIGHT);
      }
    },
    [allDayLaneHeight, clampAllDayLaneHeight, onAllDayLaneHeightChange],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!e.shiftKey) return;
      if (e.ctrlKey || e.metaKey) return;

      const container = scrollRef.current;
      if (!container) return;
      const dayW = dayColWidthRef.current;
      if (dayW <= 0) return;

      const delta = scaleShiftWheelDelta(
        normalizeShiftWheelDelta({
          shiftKey: e.shiftKey,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          pageHeight: container.clientHeight,
        }),
      );
      if (delta === 0) return;

      e.stopPropagation();
      if (e.cancelable) e.preventDefault();

      if (shiftWheelSettleRafRef.current !== null) {
        cancelAnimationFrame(shiftWheelSettleRafRef.current);
        shiftWheelSettleRafRef.current = null;
      }

      const nextAccumulatedPx = shiftWheelAccumulatedPxRef.current + delta;
      shiftWheelAccumulatedPxRef.current = nextAccumulatedPx;
      setVisualBufferDays(resolveShiftScrollBufferDays(nextAccumulatedPx, dayW));
      setVisualOffset(nextAccumulatedPx);

      if (shiftWheelSettleTimeoutRef.current !== null) {
        window.clearTimeout(shiftWheelSettleTimeoutRef.current);
      }

      shiftWheelSettleTimeoutRef.current = window.setTimeout(() => {
        const dayWidthAtSettle = dayColWidthRef.current;
        if (dayWidthAtSettle <= 0) {
          shiftWheelSettleTimeoutRef.current = null;
          resetShiftWheelVisualState();
          return;
        }

        const settleDays = resolveShiftScrollSettleDays(
          shiftWheelAccumulatedPxRef.current,
          dayWidthAtSettle,
        );
        const startOffsetPx = visualOffsetPxRef.current;
        const endOffsetPx = settleDays * dayWidthAtSettle;
        const startedAt = performance.now();

        const commitNavigation = () => {
          shiftWheelSettleTimeoutRef.current = null;
          shiftWheelSettleRafRef.current = null;

          if (settleDays > 0) {
            for (let i = 0; i < settleDays; i += 1) {
              onNavigateNext();
            }
          } else {
            for (let i = 0; i < Math.abs(settleDays); i += 1) {
              onNavigatePrev();
            }
          }

          resetShiftWheelVisualState();
        };

        if (Math.abs(startOffsetPx - endOffsetPx) < 0.5) {
          commitNavigation();
          return;
        }

        const animateSettle = (nowTs: number) => {
          const progress = Math.min(1, (nowTs - startedAt) / SHIFT_SCROLL_SETTLE_ANIMATION_MS);
          const easedProgress = 1 - Math.pow(1 - progress, 3);
          setVisualOffset(startOffsetPx + (endOffsetPx - startOffsetPx) * easedProgress);

          if (progress >= 1) {
            commitNavigation();
            return;
          }

          shiftWheelSettleRafRef.current = requestAnimationFrame(animateSettle);
        };

        shiftWheelSettleRafRef.current = requestAnimationFrame(animateSettle);
      }, SHIFT_SCROLL_IDLE_SETTLE_DELAY_MS);
    },
    [onNavigateNext, onNavigatePrev, resetShiftWheelVisualState, setVisualOffset],
  );

  const now = new Date();
  const nowY = resolveNowY(now, hourHeight);

  const gridHeight = 24 * hourHeight;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || scrollInitRef.current) return;
    if (scrollStateKey && readRetainedScrollPosition(scrollStateKey)) {
      scrollInitRef.current = true;
      return;
    }

    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node || scrollInitRef.current) return;

      const maxScrollTop = node.scrollHeight - node.clientHeight;
      if (maxScrollTop <= 0) {
        scrollInitRef.current = true;
        return;
      }

      node.scrollTop = Math.min(8 * hourHeight, maxScrollTop);
      scrollInitRef.current = true;
    });
  }, [hourHeight, scrollStateKey]);

  const renderBufferDays = dayColWidth > 0 ? visualBufferDays : 0;
  const renderDays = useMemo(() => {
    if (visibleDays.length === 0 || renderBufferDays === 0) return visibleDays;

    const firstVisibleDay = visibleDays[0]!;
    const lastVisibleDay = visibleDays[visibleDays.length - 1]!;
    const beforeDays = Array.from({ length: renderBufferDays }, (_, index) => {
      const day = new Date(firstVisibleDay);
      day.setDate(firstVisibleDay.getDate() - renderBufferDays + index);
      return day;
    });
    const afterDays = Array.from({ length: renderBufferDays }, (_, index) => {
      const day = new Date(lastVisibleDay);
      day.setDate(lastVisibleDay.getDate() + index + 1);
      return day;
    });

    return [...beforeDays, ...visibleDays, ...afterDays];
  }, [renderBufferDays, visibleDays]);
  const slideWrapperWidth = renderBufferDays > 0 ? dayColWidth * renderDays.length : undefined;
  const slideTransform =
    renderBufferDays > 0
      ? `translateX(${-(renderBufferDays * dayColWidth + visualOffsetPx)}px)`
      : undefined;
  const renderDayStyle = renderBufferDays > 0 ? { width: dayColWidth, flexShrink: 0 } : { flex: 1 };
  const timedPagesByRenderDay = useMemo(() => {
    const byDay = new Map<string, GroupedScheduledPage[]>();
    const timedPages = previewedPages.filter((page) => !page.isAllDay);

    for (const day of renderDays) {
      const key = toDayKey(day);
      if (byDay.has(key)) continue;

      const dayPages = timedPages.filter((page) => isSameDay(page.scheduledStart, day));
      byDay.set(key, groupOverlapping(dayPages));
    }

    return byDay;
  }, [previewedPages, renderDays]);

  const packedAllDaySegments = useMemo(() => {
    const allDayPages = scheduledPages.filter((page) => Boolean(page.isAllDay));
    return packAllDaySegments(buildAllDaySegments(allDayPages, renderDays));
  }, [renderDays, scheduledPages]);

  const allDayContentHeight = useMemo(() => {
    if (packedAllDaySegments.length === 0) return ALL_DAY_EVENT_HEIGHT;
    const maxLane = packedAllDaySegments.reduce((max, item) => Math.max(max, item.lane), 0);
    return (maxLane + 1) * (ALL_DAY_EVENT_HEIGHT + ALL_DAY_EVENT_GAP);
  }, [packedAllDaySegments]);

  const allDayMoveOverlay = useMemo(() => {
    if (!allDayMovePreview) return null;

    const sourceEvent = pageById.get(allDayMovePreview.eventId);
    if (!sourceEvent) return null;

    const startDayIndex = allDayMovePreview.startDayIndex + renderBufferDays;
    const endDayIndex = allDayMovePreview.endDayIndex + renderBufferDays;
    const clippedStartDayIndex = Math.max(0, startDayIndex);
    const clippedEndDayIndex = Math.min(renderDays.length, endDayIndex);

    if (clippedEndDayIndex <= clippedStartDayIndex) return null;

    return {
      event: sourceEvent,
      startDayIndex: clippedStartDayIndex,
      endDayIndex: clippedEndDayIndex,
    };
  }, [allDayMovePreview, pageById, renderBufferDays, renderDays.length]);

  return (
    <>
      <div
        ref={setScrollRef}
        data-testid="calendar-grid-scroll"
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={retainedScroll.onScroll}
        onWheel={handleWheel}
      >
        {activeMoveDragEventId && moveDropRegion === "outside" && (
          <div className="pointer-events-none absolute top-3 right-3 z-40 rounded-md border border-(--destructive)/35 bg-(--destructive)/12 px-2 py-1 text-xs font-medium text-(--destructive)">
            Drop outside calendar to cancel
          </div>
        )}
        {/* Day headers */}
        <div
          ref={headerRef}
          className="sticky top-0 z-30 flex border-b border-(--border)"
          style={{
            backgroundColor: "var(--background)",
            width: calendarContentWidth,
            minWidth: "100%",
          }}
        >
          {/* Gutter spacer — aligns with time gutter in grid body */}
          <div style={{ width: GUTTER_WIDTH, flexShrink: 0 }} />
          {/* Sliding day header cells */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div
              data-testid="calendar-header-slide"
              style={{
                display: "flex",
                transform: slideTransform,
                width: slideWrapperWidth,
                willChange: "transform",
              }}
            >
              {renderDays.map((day, renderIdx) => {
                const isToday = isSameDay(day, now);
                const dayName = day.toLocaleDateString(undefined, { weekday: "short" });
                const dayNum = day.getDate();
                return (
                  <div
                    key={renderIdx}
                    style={renderDayStyle}
                    className="flex items-center justify-center gap-1.5 border-l border-(--border) py-2 text-center first:border-l-0"
                  >
                    <span
                      className={
                        isToday
                          ? "text-xs font-semibold tracking-wider text-info uppercase"
                          : "text-xs font-medium tracking-wider text-(--foreground-secondary) uppercase"
                      }
                    >
                      {dayName}
                    </span>
                    <span
                      className={
                        isToday
                          ? "relative text-base font-bold text-info"
                          : "text-base font-semibold text-(--foreground)"
                      }
                    >
                      {dayNum}
                      {isToday && (
                        <span className="absolute -bottom-0.5 left-1/2 h-0.5 w-3.5 -translate-x-1/2 rounded-full bg-text-info" />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* All-day lane */}
        <div
          ref={allDayRef}
          id="calendar-all-day-lane"
          className="flex"
          style={{
            height: allDayLaneHeight,
            width: calendarContentWidth,
            minWidth: "100%",
          }}
        >
          <div
            className="shrink-0 px-2 py-1 text-xs text-(--foreground-tertiary)"
            style={{ width: GUTTER_WIDTH }}
          >
            All day
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="relative h-full overflow-x-hidden overflow-y-auto">
              <div style={{ height: Math.max(allDayContentHeight + 8, allDayLaneHeight) }}>
                <div
                  data-testid="calendar-all-day-slide"
                  style={{
                    display: "flex",
                    height: "100%",
                    position: "relative",
                    transform: slideTransform,
                    width: slideWrapperWidth,
                    willChange: "transform",
                  }}
                >
                  {renderDays.map((_, renderIdx) => (
                    <div
                      key={`all-day-col-${renderIdx}`}
                      className="h-full border-l border-(--border) first:border-l-0"
                      style={renderDayStyle}
                    />
                  ))}
                  {packedAllDaySegments.map((segment) => {
                    const event = segment.event;
                    const styles = columnStyles[event.columnId];
                    const accentColor = styles?.accentColor ?? "#8E8B86";
                    const dayCount = renderDays.length;
                    const leftPct = (segment.startDayIndex / dayCount) * 100;
                    const widthPct =
                      ((segment.endDayIndex - segment.startDayIndex) / dayCount) * 100;
                    const top = segment.lane * (ALL_DAY_EVENT_HEIGHT + ALL_DAY_EVENT_GAP) + 4;
                    const isArchivedEvent = event.columnId === ARCHIVED_CARD_OPTION_ID;
                    const isMoveDragSource = activeMoveDragEventId === event.id;

                    return (
                      <button
                        key={`all-day-segment-${event.id}-${segment.startDayIndex}-${segment.lane}`}
                        type="button"
                        draggable
                        data-calendar-event-block=""
                        className="absolute h-[calc(var(--spacing)*6)] cursor-default truncate rounded-xs border-l-[calc(var(--spacing)*0.75)] px-2 text-left text-xs/6 font-medium shadow-sm focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none active:cursor-grabbing"
                        style={{
                          top,
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          borderLeftColor: accentColor,
                          backgroundColor: isArchivedEvent
                            ? `color-mix(in srgb, ${accentColor} 6%, var(--background))`
                            : `color-mix(in srgb, ${accentColor} 14%, var(--background))`,
                          opacity: isMoveDragSource ? 0.35 : isArchivedEvent ? 0.6 : 1,
                        }}
                        onDragStart={(dragEvent) => startMoveDrag(dragEvent, event)}
                        onDragEnd={() => endMoveDrag(event.id)}
                        onClick={() => handlePageOpen(event)}
                        aria-label={`${showPageKey && event.pageKey ? `${event.pageKey} ` : ""}${event.title}`}
                      >
                        {showPageKey && event.pageKey ? (
                          <span className="mr-1 font-medium tabular-nums text-(--foreground-tertiary)">
                            {event.pageKey} ·
                          </span>
                        ) : null}
                        <span>{event.title}</span>
                      </button>
                    );
                  })}
                  {allDayMoveOverlay && (
                    <div
                      className="pointer-events-none absolute z-30 h-[calc(var(--spacing)*6)] truncate rounded-xs border-l-[calc(var(--spacing)*0.75)] px-2 text-left text-xs/6 font-medium shadow-lg ring-2 ring-token-focus-border/45"
                      style={{
                        top: 4,
                        left: `calc(${(allDayMoveOverlay.startDayIndex / renderDays.length) * 100}% + 2px)`,
                        width: `calc(${((allDayMoveOverlay.endDayIndex - allDayMoveOverlay.startDayIndex) / renderDays.length) * 100}% - 4px)`,
                        borderLeftColor:
                          columnStyles[allDayMoveOverlay.event.columnId]?.accentColor ?? "#8E8B86",
                        backgroundColor: `color-mix(in srgb, ${columnStyles[allDayMoveOverlay.event.columnId]?.accentColor ?? "#8E8B86"} 24%, var(--background))`,
                      }}
                    >
                      {showPageKey && allDayMoveOverlay.event.pageKey ? (
                        <span className="mr-1 font-medium tabular-nums text-(--foreground-tertiary)">
                          {allDayMoveOverlay.event.pageKey} ·
                        </span>
                      ) : null}
                      <span>{allDayMoveOverlay.event.title}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize all-day lane"
          aria-controls="calendar-all-day-lane"
          aria-orientation="horizontal"
          aria-valuemin={ALL_DAY_LANE_MIN_HEIGHT}
          aria-valuemax={ALL_DAY_LANE_MAX_HEIGHT}
          aria-valuenow={allDayLaneHeight}
          className="relative h-px cursor-row-resize bg-(--border)/60 after:absolute after:inset-x-0 after:-top-2 after:h-5 after:content-[''] hover:bg-text-info/70 focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
          style={{
            width: calendarContentWidth,
            minWidth: "100%",
          }}
          onPointerDown={handleAllDayResizeStart}
          onKeyDown={handleAllDaySeparatorKeyDown}
        />

        {/* Grid body */}
        <div
          ref={gridBodyRef}
          className="flex"
          style={{
            height: gridHeight,
            width: calendarContentWidth,
            minWidth: "100%",
          }}
        >
          {/* Time gutter — fixed, not affected by slide */}
          <div className="relative shrink-0" style={{ width: GUTTER_WIDTH }}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute right-2 text-xs leading-none text-(--foreground-tertiary) select-none"
                style={{ top: h * hourHeight - 6 }}
              >
                {h > 0 ? formatHour(h) : ""}
              </div>
            ))}
          </div>

          {/* Day columns — clips overflow, slides horizontally */}
          <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
            <div
              data-testid="calendar-day-columns-slide"
              style={{
                display: "flex",
                height: "100%",
                transform: slideTransform,
                width: slideWrapperWidth,
                willChange: "transform",
              }}
            >
              {renderDays.map((day, renderIdx) => {
                const visibleIdx = renderIdx - renderBufferDays;
                const isBuffer = visibleIdx < 0 || visibleIdx >= visibleDays.length;
                const isToday = isSameDay(day, now);
                const events = timedPagesByRenderDay.get(toDayKey(day)) ?? [];
                const moveOverlayForDay =
                  movePreviewOverlay && isSameDay(movePreviewOverlay.scheduledStart, day)
                    ? movePreviewOverlay
                    : null;
                const moveOverlayAccentColor = moveOverlayForDay
                  ? (columnStyles[moveOverlayForDay.columnId]?.accentColor ?? "#8E8B86")
                  : "#8E8B86";
                const isMoveOverlayArchived =
                  moveOverlayForDay?.columnId === ARCHIVED_CARD_OPTION_ID;

                return (
                  <div
                    key={renderIdx}
                    className="relative border-l border-(--border) first:border-l-0"
                    style={{ ...renderDayStyle, height: gridHeight }}
                    onPointerDown={isBuffer ? undefined : (e) => handlePointerDown(e, visibleIdx)}
                    onPointerMove={isBuffer ? undefined : (e) => handlePointerMove(e, visibleIdx)}
                    onPointerUp={isBuffer ? undefined : (e) => handlePointerUp(e, visibleIdx)}
                    onPointerCancel={isBuffer ? undefined : handlePointerCancel}
                  >
                    {/* Hour lines */}
                    {HOURS.map((h) => (
                      <div
                        key={h}
                        className="absolute inset-x-0 border-t border-(--border)"
                        style={{ top: h * hourHeight }}
                      />
                    ))}

                    {/* Half-hour lines */}
                    {HOURS.map((h) => (
                      <div
                        key={`half-${h}`}
                        className="absolute inset-x-0 border-t border-(--border) opacity-30"
                        style={{ top: h * hourHeight + hourHeight / 2 }}
                      />
                    ))}

                    {/* Current time line */}
                    {isToday && (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-20 flex -translate-y-1/2 items-center"
                        style={{ top: nowY }}
                      >
                        <div className="-ml-1 size-2 shrink-0 rounded-full bg-(--destructive)" />
                        <div className="h-0.5 flex-1 bg-(--destructive)" />
                      </div>
                    )}

                    {/* Event blocks */}
                    {events.map((event) => {
                      const styles = columnStyles[event.columnId];
                      const accentColor = styles?.accentColor ?? "#8E8B86";
                      const isArchivedEvent = event.columnId === ARCHIVED_CARD_OPTION_ID;
                      const isDragSourceGhost = activeMoveDragEventId === event.id;

                      return (
                        <CalendarEventBlock
                          key={event.id}
                          id={event.id}
                          pageKey={showPageKey ? event.pageKey : null}
                          title={event.title}
                          accentColor={accentColor}
                          scheduledStart={event.scheduledStart}
                          scheduledEnd={event.scheduledEnd}
                          hourHeight={hourHeight}
                          lane={event.lane}
                          totalLanes={event.totalLanes}
                          isActive={(event.pageId ?? event.id) === pageStagePageId}
                          isInteracting={Boolean(
                            eventPreview && eventPreview.eventId === event.id && !isDragSourceGhost,
                          )}
                          interactive={!isBuffer}
                          priority={event.priority}
                          estimate={event.estimate}
                          tags={event.tags}
                          assignee={event.assignee}
                          description={event.description}
                          isRecurring={event.isRecurring}
                          isSeriesFirstOccurrence={Boolean(event.thisAndFutureEquivalentToAll)}
                          muted={isArchivedEvent}
                          dragVisual={isDragSourceGhost ? "source-ghost" : "default"}
                          onShip={
                            isArchivedEvent
                              ? undefined
                              : () =>
                                  onCompleteOccurrence(
                                    event.pageId ?? event.id,
                                    event.occurrenceStart ?? event.scheduledStart,
                                  )
                          }
                          onSkip={
                            isArchivedEvent
                              ? undefined
                              : () =>
                                  onSkipOccurrence(
                                    event.pageId ?? event.id,
                                    event.occurrenceStart ?? event.scheduledStart,
                                  )
                          }
                          onOpen={() => handlePageOpen(event)}
                          onDragStartMove={(dragEvent) => {
                            startMoveDrag(dragEvent, event);
                          }}
                          onDragEndMove={() => {
                            endMoveDrag(event.id);
                          }}
                          onPointerDownResize={(edge, pointerEvent) => {
                            startResizeInteraction(
                              pointerEvent,
                              event,
                              edge === "start" ? "resize-start" : "resize-end",
                            );
                          }}
                          onPointerMove={updateEventInteraction}
                          onPointerUp={(pointerEvent) => {
                            finishEventInteraction(pointerEvent, {
                              canceled: false,
                              reason: "pointer-up",
                            });
                          }}
                          onPointerCancel={(pointerEvent) => {
                            finishEventInteraction(pointerEvent, {
                              canceled: true,
                              reason: "pointer-cancel",
                            });
                          }}
                          onLostPointerCapture={(pointerEvent) => {
                            finishEventInteraction(pointerEvent, {
                              canceled: false,
                              reason: "lost-pointer-capture",
                            });
                          }}
                        />
                      );
                    })}

                    {moveOverlayForDay && (
                      <CalendarEventBlock
                        key={`${moveOverlayForDay.id}-drag-overlay`}
                        id={moveOverlayForDay.id}
                        pageKey={showPageKey ? moveOverlayForDay.pageKey : null}
                        title={moveOverlayForDay.title}
                        accentColor={moveOverlayAccentColor}
                        scheduledStart={moveOverlayForDay.scheduledStart}
                        scheduledEnd={moveOverlayForDay.scheduledEnd}
                        hourHeight={hourHeight}
                        lane={0}
                        totalLanes={1}
                        isActive={false}
                        isInteracting={false}
                        interactive={false}
                        priority={moveOverlayForDay.priority}
                        estimate={moveOverlayForDay.estimate}
                        tags={moveOverlayForDay.tags}
                        assignee={moveOverlayForDay.assignee}
                        description={moveOverlayForDay.description}
                        isRecurring={moveOverlayForDay.isRecurring}
                        isSeriesFirstOccurrence={Boolean(
                          moveOverlayForDay.thisAndFutureEquivalentToAll,
                        )}
                        muted={isMoveOverlayArchived}
                        dragVisual="overlay-ghost"
                        zIndex={40}
                        onOpen={() => {}}
                        onDragStartMove={undefined}
                        onDragEndMove={undefined}
                        onPointerDownResize={() => {}}
                        onPointerMove={() => {}}
                        onPointerUp={() => {}}
                        onPointerCancel={() => {}}
                        onLostPointerCapture={() => {}}
                      />
                    )}

                    {/* Drag overlay */}
                    {!isBuffer && dragState && dragState.dayIndex === visibleIdx && (
                      <div
                        className="pointer-events-none absolute inset-x-1 z-10 rounded-sm border-2 border-token-focus-border/40 bg-text-info/10"
                        style={{
                          top: Math.min(dragState.startSlot, dragState.endSlot) * slotHeight,
                          height:
                            (Math.abs(dragState.endSlot - dragState.startSlot) + 1) * slotHeight,
                        }}
                      />
                    )}

                    {/* Inline creator */}
                    {!isBuffer && creatorState && creatorState.dayIndex === visibleIdx && (
                      <CalendarInlineCreator
                        dayDate={day}
                        startSlot={creatorState.startSlot}
                        endSlot={creatorState.endSlot}
                        hourHeight={hourHeight}
                        onCommit={handleCreateCommit}
                        onCancel={handleCreateCancel}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <OccurrenceScopeDialog
        open={Boolean(pendingScopedUpdate)}
        title={pendingScopedUpdate?.eventTitle ?? ""}
        fromLabel={pendingScopedUpdate?.fromLabel ?? ""}
        toLabel={pendingScopedUpdate?.toLabel ?? ""}
        thisAndFutureEquivalentToAll={pendingScopedUpdate?.thisAndFutureEquivalentToAll ?? false}
        busy={scopeDialogBusy}
        onCancel={handleScopeCancel}
        onSelect={handleScopeSelect}
      />
    </>
  );
}
