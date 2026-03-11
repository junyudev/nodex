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
  resolveShiftWheelDelta,
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
import { stepShiftScroll } from "@/lib/calendar-shift-scroll";
import { columnStyles } from "../column";
import { CalendarEventBlock } from "./calendar-event-block";
import { CalendarInlineCreator } from "./calendar-inline-creator";
import { OccurrenceScopeDialog } from "./occurrence-scope-dialog";
import type { Card as CardType, OccurrenceEditScope } from "@/lib/types";
import { ARCHIVED_CARD_OPTION_ID } from "@/lib/kanban-options";
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

interface ScheduledCard extends Omit<CardType, "scheduledStart" | "scheduledEnd"> {
  cardId?: string;
  columnId: string;
  columnName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  occurrenceStart?: Date;
  occurrenceEnd?: Date;
  isRecurring?: boolean;
  thisAndFutureEquivalentToAll?: boolean;
}
type GroupedScheduledCard = ScheduledCard & { lane: number; totalLanes: number };

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
  cardId: string;
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
  cardId: string;
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
  cardId: string;
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
  scheduledCards: ScheduledCard[];
  cardStageCardId: string | undefined;
  onClickCard: (card: ScheduledCard) => void;
  onCreateCard: (title: string, start: Date, end: Date) => void;
  onCompleteOccurrence: (cardId: string, occurrenceStart: Date) => void;
  onSkipOccurrence: (cardId: string, occurrenceStart: Date) => void;
  onUpdateCardSchedule: (
    columnId: string,
    cardId: string,
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
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DEFAULT_CREATE_SLOTS = 2; // 30 minutes
const SHIFT_WHEEL_IDLE_MS = 72;
const DROP_PREVIEW_TIMEOUT_MS = 2000;
const ALL_DAY_EVENT_HEIGHT = 24;
const ALL_DAY_EVENT_GAP = 4;
const ALL_DAY_LANE_MIN_HEIGHT = 40;
const ALL_DAY_LANE_MAX_HEIGHT = 220;
const ALL_DAY_SEPARATOR_HEIGHT = 1;
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
  content.style.transition = "opacity 120ms ease, transform 120ms ease, background-color 120ms ease";
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
  scheduledCards,
  cardStageCardId,
  onClickCard,
  onCreateCard,
  onCompleteOccurrence,
  onSkipOccurrence,
  onUpdateCardSchedule,
  onNavigatePrev,
  onNavigateNext,
  allDayLaneHeight,
  onAllDayLaneHeightChange,
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
  const completedMoveDropRef = useRef<{ eventId: string; preserveTimedPreview: boolean } | null>(null);
  const suppressOpenRef = useRef<{ eventId: string; until: number } | null>(null);
  const eventPreviewRef = useRef<CalendarEventPreviewState | null>(null);
  const pendingDropPreviewEventIdRef = useRef<string | null>(null);
  const pendingDropPreviewTimeoutRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const allDaySlideRef = useRef<HTMLDivElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const scrollInitRef = useRef(false);
  // Smooth shift+wheel scroll
  const headerSlideRef = useRef<HTMLDivElement>(null);
  const dayColumnsSlideRef = useRef<HTMLDivElement>(null);
  const shiftTargetPxRef = useRef(0);
  const shiftCurrentPxRef = useRef(0);
  const shiftRafRef = useRef<number | null>(null);
  const dayColWidthRef = useRef(0);
  const lastWheelInputTsRef = useRef(Number.NEGATIVE_INFINITY);
  const lastFrameTsRef = useRef<number | null>(null);
  const pendingWheelNavDaysRef = useRef(0);
  const previousVisibleDaysRef = useRef(visibleDays);
  // Flag: true when the current visibleDays change was initiated by the RAF (shift+wheel),
  // false when it came from toolbar navigation. Prevents the layout effect from
  // cancelling the RAF or resetting transforms mid-animation.
  const shiftWheelNavigatingRef = useRef(false);

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

  const clearPendingDropPreview = useCallback((eventId?: string) => {
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
  }, [setEventPreviewSynced]);

  const armPendingDropPreview = useCallback((eventId: string) => {
    pendingDropPreviewEventIdRef.current = eventId;
    if (pendingDropPreviewTimeoutRef.current !== null) {
      window.clearTimeout(pendingDropPreviewTimeoutRef.current);
    }

    pendingDropPreviewTimeoutRef.current = window.setTimeout(() => {
      clearPendingDropPreview(eventId);
    }, DROP_PREVIEW_TIMEOUT_MS);
  }, [clearPendingDropPreview]);

  useEffect(() => {
    eventPreviewRef.current = eventPreview;
  }, [eventPreview]);

  // Cancel RAF on unmount
  useEffect(() => {
    return () => {
      if (shiftRafRef.current !== null) {
        cancelAnimationFrame(shiftRafRef.current);
        shiftRafRef.current = null;
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
      scrollRef.current = node;
      if (!node) return;
      updateLayoutMetrics();
    },
    [updateLayoutMetrics],
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

  // dayColWidth: width of one visible day column in pixels
  const dayColWidth = containerWidth > 0
    ? (containerWidth - GUTTER_WIDTH) / visibleDays.length
    : 0;

  useEffect(() => {
    dayColWidthRef.current = dayColWidth;
  }, [dayColWidth]);

  const applySlideTransform = useCallback((shiftPx: number, dayWidth: number) => {
    const tx = `translateX(${-(dayWidth + shiftPx)}px)`;
    if (headerSlideRef.current) headerSlideRef.current.style.transform = tx;
    if (allDaySlideRef.current) allDaySlideRef.current.style.transform = tx;
    if (dayColumnsSlideRef.current) dayColumnsSlideRef.current.style.transform = tx;
  }, []);

  const applyRestTransform = useCallback((dayWidth: number) => {
    if (dayWidth <= 0) return;
    applySlideTransform(0, dayWidth);
  }, [applySlideTransform]);

  // Synchronize post-commit transform ownership:
  // - shift+wheel navigation keeps RAF ownership
  // - toolbar navigation resets to centered rest transform
  useLayoutEffect(() => {
    const visibleDaysChanged = previousVisibleDaysRef.current !== visibleDays;
    previousVisibleDaysRef.current = visibleDays;

    if (dayColWidth <= 0) return;

    if (shiftWheelNavigatingRef.current) {
      shiftWheelNavigatingRef.current = false;
      const pendingNavDays = pendingWheelNavDaysRef.current;
      if (pendingNavDays !== 0) {
        const wrapPx = dayColWidth * pendingNavDays;
        shiftCurrentPxRef.current -= wrapPx;
        shiftTargetPxRef.current -= wrapPx;
        pendingWheelNavDaysRef.current = 0;
        applySlideTransform(shiftCurrentPxRef.current, dayColWidth);
      }
      return;
    }

    if (visibleDaysChanged && shiftRafRef.current !== null) {
      cancelAnimationFrame(shiftRafRef.current);
      shiftRafRef.current = null;
      lastFrameTsRef.current = null;
    }

    if (visibleDaysChanged) {
      shiftTargetPxRef.current = 0;
      shiftCurrentPxRef.current = 0;
      pendingWheelNavDaysRef.current = 0;
    }

    if (shiftRafRef.current !== null) return;
    applyRestTransform(dayColWidth);
  }, [applyRestTransform, dayColWidth, visibleDays]);

  // displayDays: visibleDays with 1 buffer day on each side for seamless sliding
  const displayDays = useMemo(() => {
    if (visibleDays.length === 0) return visibleDays;
    const before = new Date(visibleDays[0]);
    before.setDate(before.getDate() - 1);
    const after = new Date(visibleDays[visibleDays.length - 1]);
    after.setDate(after.getDate() + 1);
    return [before, ...visibleDays, after];
  }, [visibleDays]);

  const cardById = useMemo(
    () => new Map(scheduledCards.map((card) => [card.id, card])),
    [scheduledCards],
  );

  const isMoveDragPreviewActiveNow = Boolean(
    activeMoveDragEventId
    && eventPreview
    && eventPreview.eventId === activeMoveDragEventId,
  );

  const previewedCards = useMemo(
    () =>
      applyPreviewToScheduledEvents(scheduledCards, eventPreview, visibleDays, {
        freezeLayout: isMoveDragPreviewActiveNow,
      }),
    [eventPreview, isMoveDragPreviewActiveNow, scheduledCards, visibleDays],
  );

  const movePreviewOverlay = useMemo(
    () =>
      resolveMovePreviewOverlayEvent(cardById, eventPreview, visibleDays, {
        isMovePreviewActive: isMoveDragPreviewActiveNow,
      }),
    [cardById, eventPreview, isMoveDragPreviewActiveNow, visibleDays],
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

    const card = scheduledCards.find((scheduledCard) => scheduledCard.id === pendingEventId);
    if (!card) return;

    const dayIndex = findDayIndex(card.scheduledStart);
    if (dayIndex !== preview.dayIndex) return;

    const range = slotRangeFromDates(card.scheduledStart, card.scheduledEnd);
    if (
      range.startSlot !== preview.range.startSlot ||
      range.endSlot !== preview.range.endSlot
    ) {
      return;
    }

    clearPendingDropPreview(pendingEventId);
  }, [clearPendingDropPreview, findDayIndex, scheduledCards]);

  const resolvePointerDropTarget = useCallback(
    (
      clientX: number,
      clientY: number,
    ): CalendarMoveDropTarget | null => {
      if (visibleDays.length === 0) return null;

      const resolveDayIndexFromRect = (rect: DOMRect): number | null => {
        const dayAreaLeft = rect.left + GUTTER_WIDTH;
        const dayAreaRight = rect.right;
        if (clientX < dayAreaLeft || clientX > dayAreaRight) return null;

        const dayAreaWidth = dayAreaRight - dayAreaLeft;
        if (dayAreaWidth <= 0) return null;
        const dayWidth = dayAreaWidth / visibleDays.length;
        const relativeX = clientX - dayAreaLeft + shiftCurrentPxRef.current;
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
      card: ScheduledCard,
      mode: EventInteractionState["mode"],
    ) => {
      if (event.button !== 0) return;

      const originDayIndex = findDayIndex(card.scheduledStart);
      if (originDayIndex < 0) return;

      const originRange = slotRangeFromDates(card.scheduledStart, card.scheduledEnd);

      event.currentTarget.setPointerCapture(event.pointerId);
      clearPendingDropPreview();

      eventInteractionRef.current = {
        pointerId: event.pointerId,
        eventId: card.id,
        cardId: card.cardId ?? card.id,
        occurrenceStart: card.occurrenceStart ?? card.scheduledStart,
        columnId: card.columnId,
        mode,
        originDayIndex,
        originRange,
        pointerStartX: event.clientX,
        pointerStartY: event.clientY,
        started: true,
      };

      setCreatorState(null);
      setDragState(null);
      setEventPreviewSynced(createCalendarEventPreview(card.id, originDayIndex, originRange));
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
      {
        canceled,
      }: { canceled: boolean; reason: EventInteractionFinishReason },
    ) => {
      const interaction = eventInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      eventInteractionRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const card = cardById.get(interaction.eventId);
      const preview = eventPreviewRef.current;

      if (canceled || !card) {
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
      const isRecurringEvent = card.isRecurring || Boolean(card.recurrence);
      if (isRecurringEvent) {
        clearPendingDropPreview(interaction.eventId);
        setEventPreviewSynced(null);
        setPendingScopedUpdate({
          columnId: interaction.columnId,
          cardId: interaction.cardId,
          occurrenceStart: interaction.occurrenceStart,
          scheduledStart: rangeDates.start,
          scheduledEnd: rangeDates.end,
          isAllDay: false,
          eventTitle: card.title,
          fromLabel: formatScheduleLabel(card.scheduledStart, card.scheduledEnd, Boolean(card.isAllDay)),
          toLabel: formatScheduleLabel(rangeDates.start, rangeDates.end),
          thisAndFutureEquivalentToAll: Boolean(card.thisAndFutureEquivalentToAll),
        });
        return;
      }

      setEventPreviewSynced(nextPreview);
      armPendingDropPreview(interaction.eventId);
      void onUpdateCardSchedule(
        interaction.columnId,
        interaction.cardId,
        interaction.occurrenceStart,
        rangeDates.start,
        rangeDates.end,
        false,
      );
    },
    [
      armPendingDropPreview,
      cardById,
      clearPendingDropPreview,
      onUpdateCardSchedule,
      resolvePointerGridPosition,
      setEventPreviewSynced,
      visibleDays,
    ],
  );

  const handleCardOpen = useCallback((card: ScheduledCard) => {
    const suppress = suppressOpenRef.current;
    if (suppress && suppress.eventId === card.id && suppress.until > Date.now()) {
      return;
    }
    onClickCard(card);
  }, [onClickCard]);

  const updateMoveDragPreview = useCallback((target: CalendarMoveDropTarget | null) => {
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
        current
        && current.eventId === drag.eventId
        && current.startDayIndex === preview.startDayIndex
        && current.endDayIndex === preview.endDayIndex
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
  }, [setEventPreviewSynced]);

  const commitMoveDrop = useCallback((target: CalendarMoveDropTarget): boolean => {
    const drag = activeMoveDragRef.current;
    if (!drag) return false;

    const card = cardById.get(drag.eventId);
    if (!card) return false;

    const nextSchedule = resolveCalendarMoveDropSchedule(drag, target, visibleDays);
    if (!nextSchedule) return false;

    const unchanged = nextSchedule.isAllDay
      ? Boolean(card.isAllDay)
      && isSameDay(card.scheduledStart, nextSchedule.start)
      && resolveAllDaySpanDays(card.scheduledStart, card.scheduledEnd)
      === resolveAllDaySpanDays(nextSchedule.start, nextSchedule.end)
      : !card.isAllDay
      && card.scheduledStart.getTime() === nextSchedule.start.getTime()
      && card.scheduledEnd.getTime() === nextSchedule.end.getTime();

    if (unchanged) return false;

    const isRecurringEvent = card.isRecurring || Boolean(card.recurrence);
    if (isRecurringEvent) {
      clearPendingDropPreview(drag.eventId);
      setEventPreviewSynced(null);
      setPendingScopedUpdate({
        columnId: drag.columnId,
        cardId: drag.cardId,
        occurrenceStart: drag.occurrenceStart,
        scheduledStart: nextSchedule.start,
        scheduledEnd: nextSchedule.end,
        isAllDay: nextSchedule.isAllDay,
        eventTitle: card.title,
        fromLabel: formatScheduleLabel(card.scheduledStart, card.scheduledEnd, Boolean(card.isAllDay)),
        toLabel: formatScheduleLabel(nextSchedule.start, nextSchedule.end, nextSchedule.isAllDay),
        thisAndFutureEquivalentToAll: Boolean(card.thisAndFutureEquivalentToAll),
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

    void onUpdateCardSchedule(
      drag.columnId,
      drag.cardId,
      drag.occurrenceStart,
      nextSchedule.start,
      nextSchedule.end,
      nextSchedule.isAllDay,
    );

    return !nextSchedule.isAllDay;
  }, [
    armPendingDropPreview,
    cardById,
    clearPendingDropPreview,
    onUpdateCardSchedule,
    setEventPreviewSynced,
    visibleDays,
  ]);

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

  const startMoveDrag = useCallback((event: React.DragEvent<HTMLElement>, card: ScheduledCard) => {
    if (eventInteractionRef.current) return;

    const originDayIndex = findDayIndex(card.scheduledStart);
    if (originDayIndex < 0) return;

    const originRange = slotRangeFromDates(card.scheduledStart, card.scheduledEnd);
    const durationSlots = originRange.endSlot - originRange.startSlot + 1;
    const dropTarget = resolvePointerDropTarget(event.clientX, event.clientY);
    const pointerSlot =
      dropTarget?.region === "timed"
        ? dropTarget.slot
        : originRange.startSlot;
    const grabOffsetSlots = Math.max(
      0,
      Math.min(pointerSlot - originRange.startSlot, durationSlots - 1),
    );
    const accentColor = columnStyles[card.columnId]?.accentColor ?? "#8E8B86";
    const defaultScheduleLabel = formatScheduleLabel(
      card.scheduledStart,
      card.scheduledEnd,
      Boolean(card.isAllDay),
    );

    activeMoveDragRef.current = {
      eventId: card.id,
      cardId: card.cardId ?? card.id,
      occurrenceStart: card.occurrenceStart ?? card.scheduledStart,
      columnId: card.columnId,
      originDayIndex,
      originRange,
      originIsAllDay: Boolean(card.isAllDay),
      originalDurationMs: Math.max(60_000, card.scheduledEnd.getTime() - card.scheduledStart.getTime()),
      originalAllDaySpanDays: resolveAllDaySpanDays(card.scheduledStart, card.scheduledEnd),
      grabOffsetSlots,
      accentColor,
      defaultScheduleLabel,
    };

    completedMoveDropRef.current = null;
    suppressOpenRef.current = { eventId: card.id, until: Date.now() + 250 };
    clearPendingDropPreview();
    setCreatorState(null);
    setDragState(null);
    setEventPreviewSynced(null);
    setAllDayMovePreview(null);
    setMoveDropRegion(dropTarget?.region ?? "outside");
    setActiveMoveDragEventId(card.id);
    clearMoveDragGhost();
    moveDragGhostRef.current = createCalendarMoveDragGhost({
      title: card.title,
      accentColor,
      scheduleLabel: defaultScheduleLabel,
    });
    updateMoveDragGhost(dropTarget, event.clientX, event.clientY);

    const dragImage = createHiddenCalendarEventDragImage();

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(CALENDAR_EVENT_DRAG_MIME, card.id);
    event.dataTransfer.setData("text/plain", card.title);
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    requestAnimationFrame(() => dragImage.remove());
  }, [
    clearMoveDragGhost,
    clearPendingDropPreview,
    findDayIndex,
    resolvePointerDropTarget,
    setEventPreviewSynced,
    updateMoveDragGhost,
  ]);

  const endMoveDrag = useCallback((cardId: string) => {
    const drag = activeMoveDragRef.current;
    if (!drag || drag.eventId !== cardId) return;

    const completed = completedMoveDropRef.current;
    const preserveTimedPreview = completed?.eventId === drag.eventId && completed.preserveTimedPreview;

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
  }, [clearMoveDragGhost, clearPendingDropPreview, setEventPreviewSynced]);

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
      onCreateCard(title, start, end);
      setCreatorState(null);
    },
    [onCreateCard],
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
        const effectiveScope = pending.thisAndFutureEquivalentToAll && scope === "this-and-future"
          ? "all"
          : scope;
        await onUpdateCardSchedule(
          pending.columnId,
          pending.cardId,
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
    [onUpdateCardSchedule, pendingScopedUpdate, scopeDialogBusy],
  );

  const clampAllDayLaneHeight = useCallback((height: number) => {
    return Math.max(ALL_DAY_LANE_MIN_HEIGHT, Math.min(ALL_DAY_LANE_MAX_HEIGHT, Math.round(height)));
  }, []);

  const handleAllDayResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
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
  }, [allDayLaneHeight, clampAllDayLaneHeight, onAllDayLaneHeightChange]);

  const handleAllDaySeparatorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
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
  }, [allDayLaneHeight, clampAllDayLaneHeight, onAllDayLaneHeightChange]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.shiftKey) return;

    const container = scrollRef.current;
    if (!container) return;

    const delta = resolveShiftWheelDelta({
      shiftKey: e.shiftKey,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      pageHeight: container.clientHeight,
    });
    if (delta === 0) return;

    e.stopPropagation();
    if (e.cancelable) e.preventDefault();

    shiftTargetPxRef.current += delta;
    lastWheelInputTsRef.current = performance.now();

    if (shiftRafRef.current !== null) return; // RAF loop already running
    lastFrameTsRef.current = null;

    const animate = (nowTs: number) => {
      const dayW = dayColWidthRef.current;
      if (dayW <= 0) {
        shiftRafRef.current = null;
        lastFrameTsRef.current = null;
        return;
      }

      const previousFrameTs = lastFrameTsRef.current ?? nowTs;
      const deltaTimeMs = Math.max(0, nowTs - previousFrameTs);
      lastFrameTsRef.current = nowTs;

      const waitingForNavCommit = pendingWheelNavDaysRef.current !== 0;
      const stepResult = stepShiftScroll({
        currentPx: shiftCurrentPxRef.current,
        targetPx: shiftTargetPxRef.current,
        dayWidthPx: dayW,
        deltaTimeMs,
        isInputIdle: nowTs - lastWheelInputTsRef.current >= SHIFT_WHEEL_IDLE_MS,
        allowNavigation: !waitingForNavCommit,
      });

      shiftCurrentPxRef.current = stepResult.currentPx;
      shiftTargetPxRef.current = stepResult.targetPx;

      if (!waitingForNavCommit && stepResult.navigateDays > 0) {
        pendingWheelNavDaysRef.current = stepResult.navigateDays;
        shiftWheelNavigatingRef.current = true;
        for (let i = 0; i < pendingWheelNavDaysRef.current; i++) {
          onNavigateNext();
        }
        const wrapPx = dayW * pendingWheelNavDaysRef.current;
        shiftCurrentPxRef.current += wrapPx;
        shiftTargetPxRef.current += wrapPx;
      } else if (!waitingForNavCommit && stepResult.navigateDays < 0) {
        pendingWheelNavDaysRef.current = stepResult.navigateDays;
        shiftWheelNavigatingRef.current = true;
        for (let i = 0; i < Math.abs(pendingWheelNavDaysRef.current); i++) {
          onNavigatePrev();
        }
        const wrapPx = dayW * pendingWheelNavDaysRef.current;
        shiftCurrentPxRef.current += wrapPx;
        shiftTargetPxRef.current += wrapPx;
      }

      applySlideTransform(shiftCurrentPxRef.current, dayW);

      if (stepResult.shouldStop && pendingWheelNavDaysRef.current === 0) {
        shiftRafRef.current = null;
        lastFrameTsRef.current = null;
        applyRestTransform(dayW);
        return;
      }

      shiftRafRef.current = requestAnimationFrame(animate);
    };
    shiftRafRef.current = requestAnimationFrame(animate);
  }, [applyRestTransform, applySlideTransform, onNavigateNext, onNavigatePrev]);

  const now = new Date();
  const nowY = resolveNowY(now, hourHeight);

  const gridHeight = 24 * hourHeight;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || scrollInitRef.current) return;

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
  }, [hourHeight]);

  // Carousel is active once the container has been measured
  const carouselActive = dayColWidth > 0;
  // When carousel is active, render buffer days on each side; otherwise render visibleDays directly
  const renderDays = carouselActive ? displayDays : visibleDays;
  // Slide wrapper spans all rendered columns
  const slideWrapperWidth = carouselActive ? dayColWidth * displayDays.length : undefined;
  const timedCardsByRenderDay = useMemo(() => {
    const byDay = new Map<string, GroupedScheduledCard[]>();
    const timedCards = previewedCards.filter((card) => !card.isAllDay);

    for (const day of renderDays) {
      const key = toDayKey(day);
      if (byDay.has(key)) continue;

      const dayCards = timedCards.filter((card) => isSameDay(card.scheduledStart, day));
      byDay.set(key, groupOverlapping(dayCards));
    }

    return byDay;
  }, [previewedCards, renderDays]);

  const packedAllDaySegments = useMemo(() => {
    const allDayCards = scheduledCards.filter((card) => Boolean(card.isAllDay));
    return packAllDaySegments(buildAllDaySegments(allDayCards, renderDays));
  }, [renderDays, scheduledCards]);

  const allDayContentHeight = useMemo(() => {
    if (packedAllDaySegments.length === 0) return ALL_DAY_EVENT_HEIGHT;
    const maxLane = packedAllDaySegments.reduce((max, item) => Math.max(max, item.lane), 0);
    return (maxLane + 1) * (ALL_DAY_EVENT_HEIGHT + ALL_DAY_EVENT_GAP);
  }, [packedAllDaySegments]);

  const allDayMoveOverlay = useMemo(() => {
    if (!allDayMovePreview) return null;

    const sourceEvent = cardById.get(allDayMovePreview.eventId);
    if (!sourceEvent) return null;

    const renderOffset = carouselActive ? 1 : 0;
    const startDayIndex = allDayMovePreview.startDayIndex + renderOffset;
    const endDayIndex = allDayMovePreview.endDayIndex + renderOffset;
    const clippedStartDayIndex = Math.max(0, startDayIndex);
    const clippedEndDayIndex = Math.min(renderDays.length, endDayIndex);

    if (clippedEndDayIndex <= clippedStartDayIndex) return null;

    return {
      event: sourceEvent,
      startDayIndex: clippedStartDayIndex,
      endDayIndex: clippedEndDayIndex,
    };
  }, [allDayMovePreview, cardById, carouselActive, renderDays.length]);

  return (
    <>
      <div
        ref={setScrollRef}
        className="relative min-h-0 flex-1 overflow-auto"
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
          style={{ backgroundColor: "var(--background)" }}
        >
          {/* Gutter spacer — aligns with time gutter in grid body */}
          <div style={{ width: GUTTER_WIDTH, flexShrink: 0 }} />
          {/* Sliding day header cells */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <div
              ref={headerSlideRef}
              style={{
                display: "flex",
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
                    style={carouselActive ? { width: dayColWidth, flexShrink: 0 } : { flex: 1 }}
                    className="flex items-center justify-center gap-1.5 border-l border-(--border) py-2 text-center first:border-l-0"
                  >
                    <span
                      className={
                        isToday
                          ? "text-xs font-semibold tracking-wider text-(--accent-blue) uppercase"
                          : "text-xs font-medium tracking-wider text-(--foreground-secondary) uppercase"
                      }
                    >
                      {dayName}
                    </span>
                    <span
                      className={
                        isToday
                          ? "relative text-base font-bold text-(--accent-blue)"
                          : "text-base font-semibold text-(--foreground)"
                      }
                    >
                      {dayNum}
                      {isToday && (
                        <span className="absolute -bottom-0.5 left-1/2 h-0.5 w-3.5 -translate-x-1/2 rounded-full bg-(--accent-blue)" />
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
          style={{ height: allDayLaneHeight }}
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
                  ref={allDaySlideRef}
                  style={{
                    display: "flex",
                    height: "100%",
                    width: slideWrapperWidth,
                    willChange: "transform",
                    position: "relative",
                  }}
                >
                  {renderDays.map((_, renderIdx) => (
                    <div
                      key={`all-day-col-${renderIdx}`}
                      className="h-full border-l border-(--border) first:border-l-0"
                      style={carouselActive
                        ? { width: dayColWidth, flexShrink: 0 }
                        : { flex: 1 }
                      }
                    />
                  ))}
                  {packedAllDaySegments.map((segment) => {
                    const event = segment.event;
                    const styles = columnStyles[event.columnId];
                    const accentColor = styles?.accentColor ?? "#8E8B86";
                    const dayCount = renderDays.length;
                    const leftPct = (segment.startDayIndex / dayCount) * 100;
                    const widthPct = ((segment.endDayIndex - segment.startDayIndex) / dayCount) * 100;
                    const top = segment.lane * (ALL_DAY_EVENT_HEIGHT + ALL_DAY_EVENT_GAP) + 4;
                    const isArchivedEvent = event.columnId === ARCHIVED_CARD_OPTION_ID;
                    const isMoveDragSource = activeMoveDragEventId === event.id;

                    return (
                      <button
                        key={`all-day-segment-${event.id}-${segment.startDayIndex}-${segment.lane}`}
                        type="button"
                        draggable
                        data-calendar-event-block=""
                        className="absolute h-[calc(var(--spacing)*6)] cursor-default truncate rounded-xs border-l-[calc(var(--spacing)*0.75)] px-2 text-left text-xs/6 font-medium shadow-sm focus-visible:ring-2 focus-visible:ring-(--accent-blue) focus-visible:outline-none active:cursor-grabbing"
                        style={{
                          top,
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          borderLeftColor: accentColor,
                          backgroundColor: isArchivedEvent
                            ? `color-mix(in srgb, ${accentColor} 6%, var(--background))`
                            : `color-mix(in srgb, ${accentColor} 14%, var(--background))`,
                          opacity: isMoveDragSource ? 0.35 : (isArchivedEvent ? 0.6 : 1),
                        }}
                        onDragStart={(dragEvent) => startMoveDrag(dragEvent, event)}
                        onDragEnd={() => endMoveDrag(event.id)}
                        onClick={() => handleCardOpen(event)}
                      >
                        {event.title}
                      </button>
                    );
                  })}
                  {allDayMoveOverlay && (
                    <div
                      className="pointer-events-none absolute z-30 h-[calc(var(--spacing)*6)] truncate rounded-xs border-l-[calc(var(--spacing)*0.75)] px-2 text-left text-xs/6 font-medium shadow-lg ring-2 ring-(--accent-blue)/45"
                      style={{
                        top: 4,
                        left: `calc(${(allDayMoveOverlay.startDayIndex / renderDays.length) * 100}% + 2px)`,
                        width: `calc(${((allDayMoveOverlay.endDayIndex - allDayMoveOverlay.startDayIndex) / renderDays.length) * 100}% - 4px)`,
                        borderLeftColor: columnStyles[allDayMoveOverlay.event.columnId]?.accentColor ?? "#8E8B86",
                        backgroundColor: `color-mix(in srgb, ${columnStyles[allDayMoveOverlay.event.columnId]?.accentColor ?? "#8E8B86"} 24%, var(--background))`,
                      }}
                    >
                      {allDayMoveOverlay.event.title}
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
          className="relative h-px cursor-row-resize bg-(--border)/60 after:absolute after:inset-x-0 after:-top-2 after:h-5 after:content-[''] hover:bg-(--accent-blue)/70 focus-visible:ring-2 focus-visible:ring-(--accent-blue) focus-visible:outline-none"
          onPointerDown={handleAllDayResizeStart}
          onKeyDown={handleAllDaySeparatorKeyDown}
        />

        {/* Grid body */}
        <div ref={gridBodyRef} className="flex" style={{ height: gridHeight }}>
          {/* Time gutter — fixed, not affected by slide */}
          <div
            className="relative shrink-0"
            style={{ width: GUTTER_WIDTH }}
          >
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
              ref={dayColumnsSlideRef}
              style={{
                display: "flex",
                height: "100%",
                width: slideWrapperWidth,
                willChange: "transform",
              }}
            >
              {renderDays.map((day, renderIdx) => {
                const visibleIdx = carouselActive ? renderIdx - 1 : renderIdx;
                const isBuffer = carouselActive && (visibleIdx < 0 || visibleIdx >= visibleDays.length);
                const isToday = isSameDay(day, now);
                const events = timedCardsByRenderDay.get(toDayKey(day)) ?? [];
                const moveOverlayForDay =
                  !isBuffer &&
                    movePreviewOverlay &&
                    isSameDay(movePreviewOverlay.scheduledStart, day)
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
                    style={carouselActive
                      ? { width: dayColWidth, flexShrink: 0, height: gridHeight }
                      : { flex: 1, height: gridHeight }
                    }
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
                          title={event.title}
                          accentColor={accentColor}
                          scheduledStart={event.scheduledStart}
                          scheduledEnd={event.scheduledEnd}
                          hourHeight={hourHeight}
                          lane={event.lane}
                          totalLanes={event.totalLanes}
                          isActive={(event.cardId ?? event.id) === cardStageCardId}
                          isInteracting={Boolean(eventPreview && eventPreview.eventId === event.id && !isDragSourceGhost)}
                          interactive={!isBuffer}
                          priority={event.priority}
                          estimate={event.estimate}
                          tags={event.tags}
                          assignee={event.assignee}
                          agentStatus={event.agentStatus}
                          description={event.description}
                          isRecurring={event.isRecurring}
                          isSeriesFirstOccurrence={Boolean(event.thisAndFutureEquivalentToAll)}
                          muted={isArchivedEvent}
                          dragVisual={isDragSourceGhost ? "source-ghost" : "default"}
                          onMarkDone={isArchivedEvent
                            ? undefined
                            : () =>
                              onCompleteOccurrence(
                                event.cardId ?? event.id,
                                event.occurrenceStart ?? event.scheduledStart,
                              )}
                          onSkip={isArchivedEvent
                            ? undefined
                            : () =>
                              onSkipOccurrence(
                                event.cardId ?? event.id,
                                event.occurrenceStart ?? event.scheduledStart,
                              )}
                          onOpen={() => handleCardOpen(event)}
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
                        agentStatus={moveOverlayForDay.agentStatus}
                        description={moveOverlayForDay.description}
                        isRecurring={moveOverlayForDay.isRecurring}
                        isSeriesFirstOccurrence={Boolean(moveOverlayForDay.thisAndFutureEquivalentToAll)}
                        muted={isMoveOverlayArchived}
                        dragVisual="overlay-ghost"
                        zIndex={40}
                        onOpen={() => { }}
                        onDragStartMove={undefined}
                        onDragEndMove={undefined}
                        onPointerDownResize={() => { }}
                        onPointerMove={() => { }}
                        onPointerUp={() => { }}
                        onPointerCancel={() => { }}
                        onLostPointerCapture={() => { }}
                      />
                    )}

                    {/* Drag overlay */}
                    {!isBuffer && dragState && dragState.dayIndex === visibleIdx && (
                      <div
                        className="pointer-events-none absolute inset-x-1 z-10 rounded-sm border-2 border-(--accent-blue)/40 bg-(--accent-blue)/10"
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
