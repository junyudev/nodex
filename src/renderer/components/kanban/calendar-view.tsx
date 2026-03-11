import { useState, useMemo, useCallback, useDeferredValue, useEffect, useRef } from "react";
import { useKanban } from "@/lib/use-kanban";
import { getVisibleDays, resolveShiftWheelDirection } from "@/lib/calendar-utils";
import {
  CALENDAR_SHIFT_WHEEL_SCOPE_ATTR,
  CALENDAR_SHIFT_WHEEL_SCOPE_VALUE,
} from "@/lib/stage-wheel-navigation";
import { CalendarToolbar } from "./calendar/calendar-toolbar";
import { CalendarGrid } from "./calendar/calendar-grid";
import {
  type CalendarOccurrence,
  type Card as CardType,
} from "@/lib/types";
import {
  ARCHIVED_CARD_OPTION_ID,
  ARCHIVED_CARD_OPTION_NAME,
} from "@/lib/kanban-options";

interface CalendarViewProps {
  projectId: string;
  searchQuery: string;
  openCardStage: (
    projectId: string,
    cardId: string,
    titleSnapshot?: string,
  ) => void;
  cardStageCardId: string | undefined;
  cardStageCloseRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  pendingReminderOpen?: {
    projectId: string;
    cardId: string;
    occurrenceStart: string;
  } | null;
  onReminderHandled?: (
    payload: { projectId: string; cardId: string; occurrenceStart: string },
  ) => void;
}

const STORAGE_KEY = "nodex-calendar-prefs";
const ALL_DAY_HEIGHT_STORAGE_KEY = "nodex-calendar-all-day-heights";
const DEFAULT_ALL_DAY_LANE_HEIGHT = 72;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

interface CalendarPrefs {
  dayCount: 4 | 7;
  anchorDate?: string; // ISO date string, only valid for savedOn
  savedOn?: string;    // todayKey() at save time
}

function loadPrefs(): { dayCount: number; anchorDate: Date } {
  const today = normalizeAnchorDate(new Date());
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: CalendarPrefs = JSON.parse(stored);
      const dayCount = parsed.dayCount === 4 || parsed.dayCount === 7 ? parsed.dayCount : 7;
      if (parsed.anchorDate && parsed.savedOn === todayKey()) {
        const restored = new Date(parsed.anchorDate);
        if (!Number.isNaN(restored.getTime())) {
          return { dayCount, anchorDate: normalizeAnchorDate(restored) };
        }
      }
      return { dayCount, anchorDate: today };
    }
  } catch { /* ignore */ }
  return { dayCount: 7, anchorDate: today };
}

function savePrefs(dayCount: number, anchorDate: Date): void {
  try {
    const prefs: CalendarPrefs = {
      dayCount: dayCount as 4 | 7,
      anchorDate: anchorDate.toISOString(),
      savedOn: todayKey(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

function loadAllDayLaneHeight(projectId: string, dayCount: number): number {
  try {
    const raw = localStorage.getItem(ALL_DAY_HEIGHT_STORAGE_KEY);
    if (!raw) return DEFAULT_ALL_DAY_LANE_HEIGHT;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const key = `${projectId}:${dayCount}`;
    const height = parsed[key];
    if (!Number.isFinite(height)) return DEFAULT_ALL_DAY_LANE_HEIGHT;
    return Math.round(height);
  } catch {
    return DEFAULT_ALL_DAY_LANE_HEIGHT;
  }
}

function saveAllDayLaneHeight(projectId: string, dayCount: number, height: number): void {
  try {
    const raw = localStorage.getItem(ALL_DAY_HEIGHT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, number> : {};
    parsed[`${projectId}:${dayCount}`] = Math.round(height);
    localStorage.setItem(ALL_DAY_HEIGHT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

function normalizeAnchorDate(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function shiftAnchorDateByDays(value: Date, days: number): Date {
  const next = normalizeAnchorDate(value);
  next.setDate(next.getDate() + days);
  return next;
}

function resolveCalendarRenderWindow(
  visibleDays: Date[],
): { start: Date; endExclusive: Date } | null {
  if (visibleDays.length === 0) return null;

  const start = normalizeAnchorDate(new Date(visibleDays[0]));
  start.setDate(start.getDate() - 1);

  const endExclusive = normalizeAnchorDate(new Date(visibleDays[visibleDays.length - 1]));
  endExclusive.setDate(endExclusive.getDate() + 2);

  return { start, endExclusive };
}

type ScheduledOccurrence = CalendarOccurrence & {
  columnId: string;
  columnName: string;
  scheduledStart: Date;
  scheduledEnd: Date;
};

function toScheduledOccurrence(occurrence: CalendarOccurrence): ScheduledOccurrence | null {
  if (!occurrence.scheduledStart || !occurrence.scheduledEnd) return null;
  return {
    ...occurrence,
    columnId: occurrence.archived ? ARCHIVED_CARD_OPTION_ID : occurrence.status,
    columnName: occurrence.archived ? ARCHIVED_CARD_OPTION_NAME : occurrence.statusName,
    scheduledStart: occurrence.scheduledStart,
    scheduledEnd: occurrence.scheduledEnd,
  };
}

export function CalendarView({
  projectId,
  searchQuery,
  openCardStage,
  cardStageCardId,
  pendingReminderOpen,
  onReminderHandled,
}: CalendarViewProps) {
  const {
    board,
    createCard,
    updateCard,
    getCard,
    listCalendarOccurrences,
    completeOccurrence,
    skipOccurrence,
    updateOccurrence,
  } = useKanban({
    projectId,
  });

  const [anchorDate, setAnchorDate] = useState(() => loadPrefs().anchorDate);
  const [dayCount, setDayCount] = useState(() => loadPrefs().dayCount);
  const [allDayLaneHeight, setAllDayLaneHeight] = useState(() =>
    loadAllDayLaneHeight(projectId, loadPrefs().dayCount),
  );

  const visibleDays = useMemo(() => {
    // For 4-day view, offset start by -1 so the window is [today-1, today+2].
    const effectiveAnchor = dayCount === 4 ? shiftAnchorDateByDays(anchorDate, -1) : anchorDate;
    return getVisibleDays(effectiveAnchor, dayCount);
  }, [anchorDate, dayCount]);
  const renderWindow = useMemo(() => resolveCalendarRenderWindow(visibleDays), [visibleDays]);
  const [scheduledCards, setScheduledCards] = useState<ScheduledOccurrence[]>([]);
  type OccurrenceOverlay =
    | { kind: "hide" }
    | { kind: "upsert"; event: ScheduledOccurrence };
  const [occurrenceOverlayById, setOccurrenceOverlayById] = useState<Map<string, OccurrenceOverlay>>(
    () => new Map(),
  );
  const scheduledCardsRef = useRef<ScheduledOccurrence[]>([]);

  const deferredSearch = useDeferredValue(searchQuery);

  useEffect(() => {
    if (!renderWindow) {
      setScheduledCards([]);
      return;
    }

    let cancelled = false;
    void listCalendarOccurrences(
      renderWindow.start,
      renderWindow.endExclusive,
      deferredSearch,
    ).then((occurrences) => {
      if (cancelled) return;
      setScheduledCards(occurrences.map(toScheduledOccurrence).filter((occurrence): occurrence is ScheduledOccurrence => Boolean(occurrence)));
    });

    return () => {
      cancelled = true;
    };
  }, [board, deferredSearch, listCalendarOccurrences, renderWindow]);

  useEffect(() => {
    scheduledCardsRef.current = scheduledCards;
  }, [scheduledCards]);

  const handleToday = useCallback(() => setAnchorDate(normalizeAnchorDate(new Date())), []);
  const handlePrev = useCallback(
    () =>
      setAnchorDate((prev) => shiftAnchorDateByDays(prev, -dayCount)),
    [dayCount],
  );
  const handleNext = useCallback(
    () =>
      setAnchorDate((prev) => shiftAnchorDateByDays(prev, dayCount)),
    [dayCount],
  );
  const handleShiftWheelPrev = useCallback(
    () => setAnchorDate((prev) => shiftAnchorDateByDays(prev, -1)),
    [],
  );
  const handleShiftWheelNext = useCallback(
    () => setAnchorDate((prev) => shiftAnchorDateByDays(prev, 1)),
    [],
  );
  const handleCalendarWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const direction = resolveShiftWheelDirection({
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      pageHeight: event.currentTarget.clientHeight,
    });
    if (direction === 0) return;

    event.stopPropagation();
    if (event.cancelable) event.preventDefault();

    if (direction > 0) {
      handleShiftWheelNext();
      return;
    }

    handleShiftWheelPrev();
  }, [handleShiftWheelNext, handleShiftWheelPrev]);
  useEffect(() => {
    savePrefs(dayCount, anchorDate);
  }, [dayCount, anchorDate]);

  useEffect(() => {
    setAllDayLaneHeight(loadAllDayLaneHeight(projectId, dayCount));
  }, [dayCount, projectId]);

  useEffect(() => {
    saveAllDayLaneHeight(projectId, dayCount, allDayLaneHeight);
  }, [allDayLaneHeight, dayCount, projectId]);

  const handleSetDayCount = useCallback((count: number) => {
    setDayCount(count);
  }, []);

  const handleAllDayLaneHeightChange = useCallback((height: number) => {
    setAllDayLaneHeight(height);
  }, []);

  const masterCardsById = useMemo(() => {
    const cards = new Map<string, { card: CardType; columnId: string }>();
    if (!board) return cards;
    for (const column of board.columns) {
      for (const card of column.cards) {
        cards.set(card.id, { card, columnId: column.id });
      }
    }
    return cards;
  }, [board]);

  const handleClickCard = useCallback(
    async (card: CardType & { columnId: string; cardId?: string }) => {
      const masterCardId = card.cardId ?? card.id;
      const cached = masterCardsById.get(masterCardId);

      if (cached) {
        openCardStage(projectId, cached.card.id, cached.card.title);
        return;
      }

      const loaded = await getCard(masterCardId, card.columnId);
      if (loaded) {
        openCardStage(projectId, loaded.id, loaded.title);
        return;
      }

      openCardStage(projectId, masterCardId, card.title);
    },
    [getCard, masterCardsById, openCardStage, projectId],
  );

  const handleCreateCard = useCallback(
    async (title: string, start: Date, end: Date) => {
      const clientId = `card:${crypto.randomUUID()}`;
      const optimisticEventId = `${clientId}:${start.toISOString()}`;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.set(optimisticEventId, {
          kind: "upsert",
          event: {
            id: optimisticEventId,
            cardId: clientId,
            status: "draft",
            archived: false,
            statusName: "Draft",
            columnId: "draft",
            columnName: "Draft",
            title,
            description: "",
            priority: "p2-medium",
            tags: [],
            agentBlocked: false,
            created: new Date(),
            order: 0,
            scheduledStart: start,
            scheduledEnd: end,
            occurrenceStart: start,
            occurrenceEnd: end,
            isRecurring: false,
          },
        });
        return next;
      });
      const created = await createCard("draft", {
        clientId,
        title,
        scheduledStart: start,
        scheduledEnd: end,
      });
      if (created) return;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.delete(optimisticEventId);
        return next;
      });
    },
    [createCard],
  );

  const handleUpdateCardSchedule = useCallback(
    async (
      columnId: string,
      cardId: string,
      occurrenceStart: Date,
      scheduledStart: Date,
      scheduledEnd: Date,
      isAllDay?: boolean,
      scope?: "this" | "this-and-future" | "all",
    ) => {
      const scheduleUpdates = {
        scheduledStart,
        scheduledEnd,
        ...(isAllDay === undefined ? {} : { isAllDay }),
      };
      if (scope) {
        const sourceOccurrenceId = `${cardId}:${occurrenceStart.toISOString()}`;
        const source = scheduledCardsRef.current.find((event) => event.id === sourceOccurrenceId);
        const overlayId = `${cardId}:${scheduledStart.toISOString()}`;
        setOccurrenceOverlayById((current) => {
          const next = new Map(current);
          next.set(sourceOccurrenceId, { kind: "hide" });
          if (source) {
            next.set(overlayId, {
              kind: "upsert",
              event: {
                ...source,
                id: overlayId,
                scheduledStart,
                scheduledEnd,
                occurrenceStart: scheduledStart,
                occurrenceEnd: scheduledEnd,
                isAllDay: isAllDay ?? source.isAllDay,
              },
            });
          }
          return next;
        });

        const updated = await updateOccurrence({
          cardId,
          occurrenceStart,
          source: "calendar",
          scope,
          updates: scheduleUpdates,
        });
        if (updated) return;
        setOccurrenceOverlayById((current) => {
          const next = new Map(current);
          next.delete(sourceOccurrenceId);
          next.delete(overlayId);
          return next;
        });
        return;
      }

      const sourceOccurrenceId = `${cardId}:${occurrenceStart.toISOString()}`;
      const source = scheduledCardsRef.current.find((event) => event.id === sourceOccurrenceId);
      const overlayId = `${cardId}:${scheduledStart.toISOString()}`;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.set(sourceOccurrenceId, { kind: "hide" });
        if (source) {
          next.set(overlayId, {
            kind: "upsert",
            event: {
              ...source,
              id: overlayId,
              scheduledStart,
              scheduledEnd,
              occurrenceStart: scheduledStart,
              occurrenceEnd: scheduledEnd,
              isAllDay: isAllDay ?? source.isAllDay,
            },
          });
        }
        return next;
      });

      const updated = await updateCard(columnId, cardId, scheduleUpdates);
      if (updated.status === "updated") return;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.delete(sourceOccurrenceId);
        next.delete(overlayId);
        return next;
      });
    },
    [updateCard, updateOccurrence],
  );

  const handleCompleteOccurrence = useCallback(
    async (cardId: string, occurrenceStart: Date) => {
      const key = `${cardId}:${occurrenceStart.toISOString()}`;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.set(key, { kind: "hide" });
        return next;
      });
      const completed = await completeOccurrence({
        cardId,
        occurrenceStart,
        source: "calendar",
      });
      if (completed) return;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    },
    [completeOccurrence],
  );

  const handleSkipOccurrence = useCallback(
    async (cardId: string, occurrenceStart: Date) => {
      const key = `${cardId}:${occurrenceStart.toISOString()}`;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.set(key, { kind: "hide" });
        return next;
      });
      const skipped = await skipOccurrence({
        cardId,
        occurrenceStart,
        source: "calendar",
      });
      if (skipped) return;
      setOccurrenceOverlayById((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    },
    [skipOccurrence],
  );

  useEffect(() => {
    if (occurrenceOverlayById.size === 0) return;
    setOccurrenceOverlayById((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [id, overlay] of current) {
        const scheduled = scheduledCards.find((event) => event.id === id);
        if (overlay.kind === "hide") {
          if (!scheduled) {
            next.delete(id);
            changed = true;
          }
          continue;
        }

        if (!scheduled) continue;
        if (
          scheduled.scheduledStart.getTime() === overlay.event.scheduledStart.getTime()
          && scheduled.scheduledEnd.getTime() === overlay.event.scheduledEnd.getTime()
        ) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [occurrenceOverlayById, scheduledCards]);

  const displayScheduledCards = useMemo(() => {
    if (occurrenceOverlayById.size === 0) return scheduledCards;

    const byId = new Map(scheduledCards.map((event) => [event.id, event]));
    for (const [id, overlay] of occurrenceOverlayById) {
      if (overlay.kind === "hide") {
        byId.delete(id);
        continue;
      }
      byId.set(id, overlay.event);
    }

    return [...byId.values()].sort((left, right) => (
      left.scheduledStart.getTime() - right.scheduledStart.getTime()
    ));
  }, [occurrenceOverlayById, scheduledCards]);

  useEffect(() => {
    if (!pendingReminderOpen) return;
    if (pendingReminderOpen.projectId !== projectId) return;

    let cancelled = false;
    void getCard(pendingReminderOpen.cardId).then((result) => {
      if (cancelled) return;
      if (result) openCardStage(projectId, result.id, result.title);
      onReminderHandled?.(pendingReminderOpen);
    });

    return () => {
      cancelled = true;
    };
  }, [
    getCard,
    onReminderHandled,
    openCardStage,
    pendingReminderOpen,
    projectId,
  ]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onWheel={handleCalendarWheel}
      {...{ [CALENDAR_SHIFT_WHEEL_SCOPE_ATTR]: CALENDAR_SHIFT_WHEEL_SCOPE_VALUE }}
    >
      <CalendarToolbar
        visibleDays={visibleDays}
        dayCount={dayCount}
        onToday={handleToday}
        onPrev={handlePrev}
        onNext={handleNext}
        onSetDayCount={handleSetDayCount}
      />
      <CalendarGrid
        visibleDays={visibleDays}
        scheduledCards={displayScheduledCards}
        cardStageCardId={cardStageCardId}
        onClickCard={handleClickCard}
        onCreateCard={handleCreateCard}
        onCompleteOccurrence={handleCompleteOccurrence}
        onSkipOccurrence={handleSkipOccurrence}
        onUpdateCardSchedule={handleUpdateCardSchedule}
        onNavigatePrev={handleShiftWheelPrev}
        onNavigateNext={handleShiftWheelNext}
        allDayLaneHeight={allDayLaneHeight}
        onAllDayLaneHeightChange={handleAllDayLaneHeightChange}
      />
    </div>
  );
}
