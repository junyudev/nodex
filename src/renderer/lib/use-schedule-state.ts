import { useState, useCallback, useRef, useEffect } from "react";
import type {
  Card,
  CardInput,
  RecurrenceConfig,
  RecurrenceFrequency,
  ReminderConfig,
} from "@/lib/types";
import { formatTimeRange } from "@/lib/calendar-utils";
import {
  resolveAllDaySpanDays,
  resolveAllDayToTimedDurationMs,
  toAllDayRangeFromTimedDrop,
} from "@/lib/calendar-all-day-utils";

// ── Constants ────────────────────────────────────────────────────────────────

export const REPEAT_FREQUENCIES: RecurrenceFrequency[] = ["daily", "weekly", "monthly", "yearly"];
export const REMINDER_PRESET_OFFSETS = [0, 10, 30, 60, 24 * 60];
const DEFAULT_SCHEDULE_DURATION_MINUTES = 60;
export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function normalizeReminderOffsets(raw: string): number[] {
  const offsets = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isInteger(value) && value >= 0);
  return Array.from(new Set(offsets)).sort((left, right) => left - right);
}

export function reminderInputFromConfigs(reminders: ReminderConfig[] | undefined): string {
  if (!reminders || reminders.length === 0) return "";
  return reminders
    .map((entry) => entry.offsetMinutes)
    .sort((left, right) => left - right)
    .join(", ");
}

export function recurrenceFromCard(card: Card): {
  enabled: boolean;
  frequency: RecurrenceFrequency;
  interval: string;
  byWeekdays: number[];
  endType: "never" | "untilDate";
  untilDate: string;
} {
  const recurrence = card.recurrence;
  if (!recurrence) {
    return {
      enabled: false,
      frequency: "daily",
      interval: "1",
      byWeekdays: [],
      endType: "never",
      untilDate: "",
    };
  }

  const untilDate =
    recurrence.endCondition?.type === "untilDate"
      ? recurrence.endCondition.untilDate
      : "";
  return {
    enabled: true,
    frequency: recurrence.frequency,
    interval: String(Math.max(1, recurrence.interval)),
    byWeekdays: recurrence.byWeekdays ?? [],
    endType: recurrence.endCondition?.type === "untilDate" ? "untilDate" : "never",
    untilDate,
  };
}

export function formatReminderOffset(offset: number): string {
  if (offset === 0) return "At time";
  if (offset < 60) return `${offset}m`;
  if (offset % 60 === 0 && offset < 24 * 60) return `${offset / 60}h`;
  if (offset % (24 * 60) === 0) return `${offset / (24 * 60)}d`;
  return `${offset}m`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function toDateTimeLocalValue(value: Date | null | undefined): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}T${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

export function toDateLocalValue(value: Date | null | undefined): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

export function parseDateTimeLocalValue(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function parseDateLocalValue(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function toAllDayEndInputValue(endExclusive: Date | null | undefined): string {
  if (!(endExclusive instanceof Date) || Number.isNaN(endExclusive.getTime())) return "";
  return toDateLocalValue(addDays(endExclusive, -1));
}

export function parseAllDayEndInputValue(value: string): Date | null {
  const parsed = parseDateLocalValue(value);
  if (!parsed) return null;
  return addDays(parsed, 1);
}

function buildDefaultScheduleRange(baseDate: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(baseDate);
  start.setSeconds(0, 0);
  const minuteOffset = start.getMinutes() % 15;
  if (minuteOffset !== 0) {
    start.setMinutes(start.getMinutes() + (15 - minuteOffset));
  }
  const end = new Date(start.getTime() + DEFAULT_SCHEDULE_DURATION_MINUTES * 60_000);
  return { start, end };
}

export function formatScheduleDuration(start: Date, end: Date): string {
  const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

export function formatAllDayDuration(days: number): string {
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function formatScheduleDateLabel(start: Date, end: Date): string {
  const startLabel = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const endLabel = end.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (startLabel === endLabel) return startLabel;
  return `${startLabel} – ${endLabel}`;
}

export function formatRecurrenceSummary(
  enabled: boolean,
  frequency: RecurrenceFrequency,
  interval: string,
): string {
  if (!enabled) return "None";
  const n = Math.max(1, Number.parseInt(interval, 10) || 1);
  if (n === 1) {
    const labels: Record<RecurrenceFrequency, string> = {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      yearly: "Yearly",
    };
    return labels[frequency];
  }
  return `Every ${n} ${frequency}`;
}

export function formatRemindersSummary(raw: string): string {
  const offsets = normalizeReminderOffsets(raw);
  if (offsets.length === 0) return "None";
  return offsets.map(formatReminderOffset).join(", ");
}

// ── Hook types ───────────────────────────────────────────────────────────────

export interface ScheduleSummary {
  date: string;
  time: string;
  duration: string;
}

export interface UseScheduleStateOptions {
  card: Card | null;
  saveProperty: (updates: Partial<CardInput>) => void;
  onCompleteOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
  onSkipOccurrence?: (cardId: string, occurrenceStart: Date) => Promise<void>;
}

export interface ScheduleState {
  scheduledStart: string;
  scheduledEnd: string;
  isAllDay: boolean;
  scheduleHint: string | null;
  recurrenceEnabled: boolean;
  recurrenceFrequency: RecurrenceFrequency;
  recurrenceInterval: string;
  recurrenceWeekdays: number[];
  recurrenceEndType: "never" | "untilDate";
  recurrenceUntilDate: string;
  reminderOffsets: string;
  scheduleTimezone: string;
  occurrenceBusy: boolean;
  scheduleSummary: ScheduleSummary | null;
  applyScheduleState: (card: Card) => void;
  applyRecurrenceState: (card: Card) => void;
  handleScheduledStartChange: (value: string) => void;
  handleScheduledEndChange: (value: string) => void;
  handleToggleAllDay: () => void;
  handleSetDefaultSchedule: () => void;
  handleClearSchedule: () => void;
  setRecurrenceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setRecurrenceFrequency: React.Dispatch<React.SetStateAction<RecurrenceFrequency>>;
  setRecurrenceInterval: React.Dispatch<React.SetStateAction<string>>;
  setRecurrenceWeekdays: React.Dispatch<React.SetStateAction<number[]>>;
  setRecurrenceEndType: React.Dispatch<React.SetStateAction<"never" | "untilDate">>;
  setRecurrenceUntilDate: React.Dispatch<React.SetStateAction<string>>;
  setReminderOffsets: React.Dispatch<React.SetStateAction<string>>;
  setScheduleTimezone: React.Dispatch<React.SetStateAction<string>>;
  buildRecurrenceConfig: (overrides?: {
    enabled?: boolean;
    frequency?: RecurrenceFrequency;
    interval?: string;
    byWeekdays?: number[];
    endType?: "never" | "untilDate";
    untilDate?: string;
  }) => RecurrenceConfig | null;
  persistReminderOffsets: (raw: string) => void;
  toggleReminderPreset: (offset: number) => void;
  handleCompleteThisOccurrence: () => Promise<void>;
  handleSkipThisOccurrence: () => Promise<void>;
  saveProperty: (updates: Partial<CardInput>) => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useScheduleState({
  card,
  saveProperty,
  onCompleteOccurrence,
  onSkipOccurrence,
}: UseScheduleStateOptions): ScheduleState {
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [isAllDay, setIsAllDay] = useState(false);
  const [scheduleHint, setScheduleHint] = useState<string | null>(null);
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>("daily");
  const [recurrenceInterval, setRecurrenceInterval] = useState("1");
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([]);
  const [recurrenceEndType, setRecurrenceEndType] = useState<"never" | "untilDate">("never");
  const [recurrenceUntilDate, setRecurrenceUntilDate] = useState("");
  const [reminderOffsets, setReminderOffsets] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState("");
  const [occurrenceBusy, setOccurrenceBusy] = useState(false);

  // Stable ref for saveProperty to avoid stale closures
  const savePropertyRef = useRef(saveProperty);
  useEffect(() => {
    savePropertyRef.current = saveProperty;
  }, [saveProperty]);

  const applyScheduleState = useCallback((nextCard: Card) => {
    const nextIsAllDay = Boolean(nextCard.isAllDay);
    setIsAllDay(nextIsAllDay);
    if (nextIsAllDay) {
      setScheduledStart(toDateLocalValue(nextCard.scheduledStart));
      setScheduledEnd(toAllDayEndInputValue(nextCard.scheduledEnd));
    } else {
      setScheduledStart(toDateTimeLocalValue(nextCard.scheduledStart));
      setScheduledEnd(toDateTimeLocalValue(nextCard.scheduledEnd));
    }
    setScheduleHint(null);
  }, []);

  const applyRecurrenceState = useCallback((nextCard: Card) => {
    const recurrenceState = recurrenceFromCard(nextCard);
    setRecurrenceEnabled(recurrenceState.enabled);
    setRecurrenceFrequency(recurrenceState.frequency);
    setRecurrenceInterval(recurrenceState.interval);
    setRecurrenceWeekdays(recurrenceState.byWeekdays);
    setRecurrenceEndType(recurrenceState.endType);
    setRecurrenceUntilDate(recurrenceState.untilDate);
    setReminderOffsets(reminderInputFromConfigs(nextCard.reminders));
    setScheduleTimezone(nextCard.scheduleTimezone ?? "");
  }, []);

  const buildRecurrenceConfig = useCallback(
    (overrides?: {
      enabled?: boolean;
      frequency?: RecurrenceFrequency;
      interval?: string;
      byWeekdays?: number[];
      endType?: "never" | "untilDate";
      untilDate?: string;
    }): RecurrenceConfig | null => {
      const enabled = overrides?.enabled ?? recurrenceEnabled;
      if (!enabled) return null;

      const frequency = overrides?.frequency ?? recurrenceFrequency;
      const intervalRaw = overrides?.interval ?? recurrenceInterval;
      const interval = Math.max(1, Number.parseInt(intervalRaw, 10) || 1);
      const byWeekdays = overrides?.byWeekdays ?? recurrenceWeekdays;
      const endType = overrides?.endType ?? recurrenceEndType;
      const untilDate = overrides?.untilDate ?? recurrenceUntilDate;

      const recurrence: RecurrenceConfig = {
        frequency,
        interval,
      };
      if (frequency === "weekly") {
        recurrence.byWeekdays = byWeekdays.length > 0 ? byWeekdays : [1];
      }
      recurrence.endCondition =
        endType === "untilDate" && untilDate
          ? { type: "untilDate", untilDate }
          : { type: "never" };

      return recurrence;
    },
    [
      recurrenceEnabled,
      recurrenceEndType,
      recurrenceFrequency,
      recurrenceInterval,
      recurrenceUntilDate,
      recurrenceWeekdays,
    ],
  );

  const persistScheduleValues = useCallback(
    (
      nextStartValue: string,
      nextEndValue: string,
      nextIsAllDay: boolean,
      hint?: string,
    ) => {
      const parsedStart = nextIsAllDay
        ? parseDateLocalValue(nextStartValue)
        : parseDateTimeLocalValue(nextStartValue);
      const parsedEnd = nextIsAllDay
        ? parseAllDayEndInputValue(nextEndValue)
        : parseDateTimeLocalValue(nextEndValue);
      if (!parsedStart || !parsedEnd) return;
      setScheduleHint(hint ?? null);
      savePropertyRef.current({
        scheduledStart: parsedStart,
        scheduledEnd: parsedEnd,
        isAllDay: nextIsAllDay,
      });
    },
    [],
  );

  const handleSetDefaultSchedule = useCallback(() => {
    if (isAllDay) {
      const start = parseDateLocalValue(scheduledStart) ?? parseDateLocalValue(toDateLocalValue(new Date()))!;
      const endExclusive = addDays(start, 1);
      const startValue = toDateLocalValue(start);
      const endValue = toAllDayEndInputValue(endExclusive);
      setScheduledStart(startValue);
      setScheduledEnd(endValue);
      setScheduleHint(null);
      savePropertyRef.current({
        scheduledStart: start,
        scheduledEnd: endExclusive,
        isAllDay: true,
      });
      return;
    }

    const { start, end } = buildDefaultScheduleRange();
    const startValue = toDateTimeLocalValue(start);
    const endValue = toDateTimeLocalValue(end);
    setScheduledStart(startValue);
    setScheduledEnd(endValue);
    setScheduleHint(null);
    savePropertyRef.current({
      scheduledStart: start,
      scheduledEnd: end,
      isAllDay: false,
    });
  }, [isAllDay, scheduledStart]);

  const handleClearSchedule = useCallback(() => {
    setScheduledStart("");
    setScheduledEnd("");
    setIsAllDay(false);
    setScheduleHint(null);
    savePropertyRef.current({
      scheduledStart: null,
      scheduledEnd: null,
      isAllDay: false,
    });
  }, []);

  const handleScheduledStartChange = useCallback(
    (nextValue: string) => {
      if (!nextValue) {
        handleClearSchedule();
        return;
      }

      const nextStart = isAllDay
        ? parseDateLocalValue(nextValue)
        : parseDateTimeLocalValue(nextValue);
      if (!nextStart) {
        setScheduledStart(nextValue);
        return;
      }

      const currentEnd = isAllDay
        ? parseAllDayEndInputValue(scheduledEnd)
        : parseDateTimeLocalValue(scheduledEnd);
      const needsAdjustment = !currentEnd || currentEnd.getTime() <= nextStart.getTime();
      const nextEnd = needsAdjustment
        ? (isAllDay
          ? addDays(nextStart, 1)
          : new Date(nextStart.getTime() + DEFAULT_SCHEDULE_DURATION_MINUTES * 60_000))
        : currentEnd;

      const nextEndValue = isAllDay ? toAllDayEndInputValue(nextEnd) : toDateTimeLocalValue(nextEnd);
      setScheduledStart(nextValue);
      setScheduledEnd(nextEndValue);
      persistScheduleValues(
        nextValue,
        nextEndValue,
        isAllDay,
        needsAdjustment
          ? (isAllDay ? "End date adjusted to stay after start." : "End time adjusted to stay after start.")
          : undefined,
      );
    },
    [handleClearSchedule, isAllDay, persistScheduleValues, scheduledEnd],
  );

  const handleScheduledEndChange = useCallback(
    (nextValue: string) => {
      if (!nextValue) {
        handleClearSchedule();
        return;
      }

      const nextEnd = isAllDay
        ? parseAllDayEndInputValue(nextValue)
        : parseDateTimeLocalValue(nextValue);
      if (!nextEnd) {
        setScheduledEnd(nextValue);
        return;
      }

      const currentStart = isAllDay
        ? parseDateLocalValue(scheduledStart)
        : parseDateTimeLocalValue(scheduledStart);
      const inferredStart = currentStart
        ?? (isAllDay
          ? addDays(nextEnd, -1)
          : new Date(nextEnd.getTime() - DEFAULT_SCHEDULE_DURATION_MINUTES * 60_000));
      const needsAdjustment = nextEnd.getTime() <= inferredStart.getTime();
      const adjustedEnd = needsAdjustment
        ? (isAllDay
          ? addDays(inferredStart, 1)
          : new Date(inferredStart.getTime() + DEFAULT_SCHEDULE_DURATION_MINUTES * 60_000))
        : nextEnd;

      const nextStartValue = isAllDay ? toDateLocalValue(inferredStart) : toDateTimeLocalValue(inferredStart);
      const nextEndValue = isAllDay ? toAllDayEndInputValue(adjustedEnd) : toDateTimeLocalValue(adjustedEnd);
      setScheduledStart(nextStartValue);
      setScheduledEnd(nextEndValue);
      persistScheduleValues(
        nextStartValue,
        nextEndValue,
        isAllDay,
        needsAdjustment
          ? (isAllDay ? "End date adjusted to stay after start." : "End time adjusted to stay after start.")
          : undefined,
      );
    },
    [handleClearSchedule, isAllDay, persistScheduleValues, scheduledStart],
  );

  const handleToggleAllDay = useCallback(() => {
    const nextIsAllDay = !isAllDay;
    const currentTimedStart = parseDateTimeLocalValue(scheduledStart);
    const currentTimedEnd = parseDateTimeLocalValue(scheduledEnd);
    const currentAllDayStart = parseDateLocalValue(scheduledStart);
    const currentAllDayEnd = parseAllDayEndInputValue(scheduledEnd);

    if (nextIsAllDay) {
      const fallback = buildDefaultScheduleRange();
      const baseStart = currentTimedStart ?? fallback.start;
      const baseEnd = currentTimedEnd ?? fallback.end;
      const durationMs = Math.max(60_000, baseEnd.getTime() - baseStart.getTime());
      const nextRange = toAllDayRangeFromTimedDrop(baseStart, durationMs);
      const nextStartValue = toDateLocalValue(nextRange.start);
      const nextEndValue = toAllDayEndInputValue(nextRange.end);
      setIsAllDay(true);
      setScheduledStart(nextStartValue);
      setScheduledEnd(nextEndValue);
      persistScheduleValues(nextStartValue, nextEndValue, true);
      return;
    }

    const baseStart = currentAllDayStart ?? parseDateLocalValue(toDateLocalValue(new Date()))!;
    const baseEnd = currentAllDayEnd ?? addDays(baseStart, 1);
    const start = new Date(baseStart);
    start.setHours(9, 0, 0, 0);
    const durationMs = resolveAllDayToTimedDurationMs(baseEnd.getTime() - baseStart.getTime());
    const end = new Date(start.getTime() + durationMs);
    const nextStartValue = toDateTimeLocalValue(start);
    const nextEndValue = toDateTimeLocalValue(end);
    setIsAllDay(false);
    setScheduledStart(nextStartValue);
    setScheduledEnd(nextEndValue);
    persistScheduleValues(nextStartValue, nextEndValue, false);
  }, [isAllDay, persistScheduleValues, scheduledEnd, scheduledStart]);

  const persistReminderOffsets = useCallback(
    (raw: string) => {
      const offsets = normalizeReminderOffsets(raw);
      const normalizedText = offsets.join(", ");
      setReminderOffsets(normalizedText);
      savePropertyRef.current({
        reminders: offsets.map((offsetMinutes) => ({ offsetMinutes })),
      });
    },
    [],
  );

  const toggleReminderPreset = useCallback(
    (offset: number) => {
      const current = normalizeReminderOffsets(reminderOffsets);
      const next = current.includes(offset)
        ? current.filter((value) => value !== offset)
        : [...current, offset].sort((left, right) => left - right);
      const normalizedText = next.join(", ");
      setReminderOffsets(normalizedText);
      savePropertyRef.current({
        reminders: next.map((offsetMinutes) => ({ offsetMinutes })),
      });
    },
    [reminderOffsets],
  );

  const handleCompleteThisOccurrence = useCallback(async () => {
    if (!card?.scheduledStart || !onCompleteOccurrence) return;
    setOccurrenceBusy(true);
    try {
      await onCompleteOccurrence(card.id, card.scheduledStart);
    } finally {
      setOccurrenceBusy(false);
    }
  }, [card, onCompleteOccurrence]);

  const handleSkipThisOccurrence = useCallback(async () => {
    if (!card?.scheduledStart || !onSkipOccurrence) return;
    setOccurrenceBusy(true);
    try {
      await onSkipOccurrence(card.id, card.scheduledStart);
    } finally {
      setOccurrenceBusy(false);
    }
  }, [card, onSkipOccurrence]);

  // Derived schedule summary
  const parsedScheduledStart = isAllDay
    ? parseDateLocalValue(scheduledStart)
    : parseDateTimeLocalValue(scheduledStart);
  const parsedScheduledEnd = isAllDay
    ? parseAllDayEndInputValue(scheduledEnd)
    : parseDateTimeLocalValue(scheduledEnd);
  const scheduleSummary: ScheduleSummary | null = parsedScheduledStart && parsedScheduledEnd
    ? (isAllDay
      ? {
          date: formatScheduleDateLabel(parsedScheduledStart, addDays(parsedScheduledEnd, -1)),
          time: "All day",
          duration: formatAllDayDuration(resolveAllDaySpanDays(parsedScheduledStart, parsedScheduledEnd)),
        }
      : {
          date: formatScheduleDateLabel(parsedScheduledStart, parsedScheduledEnd),
          time: formatTimeRange(parsedScheduledStart, parsedScheduledEnd),
          duration: formatScheduleDuration(parsedScheduledStart, parsedScheduledEnd),
        })
    : null;

  return {
    scheduledStart,
    scheduledEnd,
    isAllDay,
    scheduleHint,
    recurrenceEnabled,
    recurrenceFrequency,
    recurrenceInterval,
    recurrenceWeekdays,
    recurrenceEndType,
    recurrenceUntilDate,
    reminderOffsets,
    scheduleTimezone,
    occurrenceBusy,
    scheduleSummary,
    applyScheduleState,
    applyRecurrenceState,
    handleScheduledStartChange,
    handleScheduledEndChange,
    handleToggleAllDay,
    handleSetDefaultSchedule,
    handleClearSchedule,
    setRecurrenceEnabled,
    setRecurrenceFrequency,
    setRecurrenceInterval,
    setRecurrenceWeekdays,
    setRecurrenceEndType,
    setRecurrenceUntilDate,
    setReminderOffsets,
    setScheduleTimezone,
    buildRecurrenceConfig,
    persistReminderOffsets,
    toggleReminderPreset,
    handleCompleteThisOccurrence,
    handleSkipThisOccurrence,
    saveProperty,
  };
}
