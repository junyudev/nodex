import type { NfmDateMentionInlineContent } from "./types";
import { escapeXmlAttr, getXmlAttr } from "./xml-attributes";

export type NfmDateMentionType = "date" | "datetime" | "daterange" | "datetimerange";
export type NfmDateMentionValueKind = "date" | "datetime";
export type NfmDateMentionDateFormat =
  | "relative"
  | "ll"
  | "MM/DD/YYYY"
  | "DD/MM/YYYY"
  | "YYYY/MM/DD";
export type NfmDateMentionTimeFormat = "12h" | "24h";

export interface ParsedDateMentionValue {
  kind: NfmDateMentionValueKind;
  value: string;
  date: string;
  time?: string;
  offset?: string;
}

export const NFM_DATE_MENTION_DATE_FORMATS: NfmDateMentionDateFormat[] = [
  "relative",
  "ll",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "YYYY/MM/DD",
];

export const NFM_DATE_MENTION_TIME_FORMATS: NfmDateMentionTimeFormat[] = ["12h", "24h"];

export const NFM_DATE_MENTION_REMINDER_PRESETS = [
  "minute:0",
  "minute:10",
  "minute:30",
  "hour:1",
  "day:0@09:00",
  "day:1@09:00",
] as const;

export type NfmDateMentionReminderPreset = (typeof NFM_DATE_MENTION_REMINDER_PRESETS)[number];

export interface DateMentionFormatOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
  relative?: boolean;
}

export interface DateMentionQueryMatch {
  key: string;
  title: string;
  subtext: string;
  aliases: string[];
  payload: NfmDateMentionInlineContent;
  group: "Dates" | "Reminders";
  priority: number;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_VALUE_RE =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)([zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UTC_OFFSET_RE = /^([zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const SHORT_US_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;
const MONTH_NAME_DATE_RE = /^([a-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{2}|\d{4}))?$/i;

const MONTH_INDEX_BY_NAME = new Map(
  [
    "jan",
    "january",
    "feb",
    "february",
    "mar",
    "march",
    "apr",
    "april",
    "may",
    "jun",
    "june",
    "jul",
    "july",
    "aug",
    "august",
    "sep",
    "sept",
    "september",
    "oct",
    "october",
    "nov",
    "november",
    "dec",
    "december",
  ].map((name, index) => [name, Math.floor(index / 2)]),
);

export function getLocalDateMentionTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function todayIsoDate(now = new Date()): string {
  return dateToIsoDate(now);
}

export function currentIsoTime(now = new Date()): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function dateToIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function addIsoDateDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return dateToIsoDate(date);
}

export function isValidIsoDate(value: string | undefined): boolean {
  return Boolean(value && parseIsoDate(value));
}

export function isValidTimeString(value: string | undefined): boolean {
  return Boolean(value && TIME_RE.test(value));
}

export function isoDateToDate(value: string | undefined): Date | null {
  return parseIsoDate(value);
}

export function parseDateMentionValue(value: string | undefined): ParsedDateMentionValue | null {
  const normalized = normalizeDateMentionValue(value);
  if (!normalized) return null;

  if (isValidIsoDate(normalized)) {
    return {
      kind: "date",
      value: normalized,
      date: normalized,
    };
  }

  const match = normalized.match(DATE_TIME_VALUE_RE);
  if (!match) return null;
  return {
    kind: "datetime",
    value: normalized,
    date: match[1] ?? "",
    time: `${match[2] ?? ""}:${match[3] ?? ""}`,
    offset: normalizeUtcOffset(match[5]) ?? "Z",
  };
}

export function normalizeDateMentionValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (isValidIsoDate(trimmed)) return trimmed;

  const match = trimmed.match(DATE_TIME_VALUE_RE);
  if (!match) return null;

  const date = match[1] ?? "";
  if (!isValidIsoDate(date)) return null;

  const hourMinute = `${match[2] ?? ""}:${match[3] ?? ""}`;
  const offset = normalizeUtcOffset(match[5]);
  if (!offset) return null;

  return `${date}T${hourMinute}:00${offset}`;
}

export function isDateMentionDateTimeValue(value: string | undefined): boolean {
  return parseDateMentionValue(value)?.kind === "datetime";
}

export function dateMentionValueToIsoDate(value: string | undefined): string | null {
  return parseDateMentionValue(value)?.date ?? null;
}

export function dateMentionValueToTime(value: string | undefined): string | null {
  return parseDateMentionValue(value)?.time ?? null;
}

export function dateMentionValueToUtcOffset(value: string | undefined): string | null {
  return parseDateMentionValue(value)?.offset ?? null;
}

export function createDateMentionDateTimeValue(
  date: string,
  time: string,
  timeZone?: string,
  fallbackOffset?: string | null,
): string {
  const safeDate = isValidIsoDate(date) ? date : todayIsoDate();
  const safeTime = isValidTimeString(time) ? time : currentIsoTime();
  const offset = timeZone
    ? getUtcOffsetForTimeZone(safeDate, safeTime, timeZone)
    : normalizeUtcOffset(fallbackOffset ?? undefined);
  const resolvedOffset = offset ?? getLocalUtcOffsetForDateTime(safeDate, safeTime);
  return `${safeDate}T${safeTime}:00${resolvedOffset}`;
}

export function getDateMentionType(
  input: Partial<NfmDateMentionInlineContent> | undefined,
): NfmDateMentionType | null {
  const normalized = normalizeDateMention(input);
  if (!normalized) return null;
  const hasEnd = Boolean(normalized.end);
  const hasTime = isDateMentionDateTimeValue(normalized.start);
  if (hasEnd && hasTime) return "datetimerange";
  if (hasEnd) return "daterange";
  if (hasTime) return "datetime";
  return "date";
}

export function normalizeDateMention(
  input: Partial<NfmDateMentionInlineContent> | undefined,
): NfmDateMentionInlineContent | null {
  if (!input) return null;

  const start = normalizeDateMentionValue(input.start);
  if (!start) return null;

  const startParts = parseDateMentionValue(start);
  if (!startParts) return null;

  const rawEnd = input.end?.trim();
  const end = rawEnd ? normalizeDateMentionValue(rawEnd) : undefined;
  if (rawEnd && !end) return null;

  const endParts = end ? parseDateMentionValue(end) : null;
  if (endParts && endParts.kind !== startParts.kind) return null;

  const repaired = end
    ? repairDateMentionRange(start, end, startParts.kind)
    : { start, end: undefined };
  const format = normalizeDateFormat(input.format);
  const timeFormat =
    startParts.kind === "datetime" ? normalizeTimeFormat(input.timeFormat) : undefined;
  const tz = startParts.kind === "datetime" ? normalizeTimeZone(input.tz) : undefined;
  const reminder = normalizeReminder(input.reminder);

  return {
    type: "dateMention",
    start: repaired.start,
    ...(repaired.end ? { end: repaired.end } : {}),
    ...(tz ? { tz } : {}),
    ...(format ? { format } : {}),
    ...(timeFormat ? { timeFormat } : {}),
    ...(reminder ? { reminder } : {}),
  };
}

export function createDateMentionPayload(
  start: string,
  options: {
    end?: string;
    tz?: string;
    format?: NfmDateMentionDateFormat;
    timeFormat?: NfmDateMentionTimeFormat;
    reminder?: string;
  } = {},
): NfmDateMentionInlineContent {
  const normalized = normalizeDateMention({
    type: "dateMention",
    start,
    end: options.end,
    tz: options.tz,
    format: options.format ?? "relative",
    timeFormat: options.timeFormat,
    reminder: options.reminder,
  });

  if (normalized) return normalized;

  return {
    type: "dateMention",
    start: isValidIsoDate(start) ? start : todayIsoDate(),
    format: "relative",
  };
}

export function parseDateMentionAttrs(attrString: string): NfmDateMentionInlineContent | null {
  return normalizeDateMention({
    type: "dateMention",
    start: getXmlAttr(attrString, "start"),
    end: getXmlAttr(attrString, "end"),
    tz: getXmlAttr(attrString, "tz"),
    format: getXmlAttr(attrString, "format") as NfmDateMentionDateFormat | undefined,
    timeFormat: getXmlAttr(attrString, "time-format") as NfmDateMentionTimeFormat | undefined,
    reminder: getXmlAttr(attrString, "reminder"),
  });
}

export function serializeDateMentionAttrs(item: NfmDateMentionInlineContent): string {
  const normalized = normalizeDateMention(item);
  if (!normalized) return "";

  const attrs = [`start="${escapeXmlAttr(normalized.start)}"`];
  if (normalized.end) attrs.push(`end="${escapeXmlAttr(normalized.end)}"`);
  if (normalized.tz) attrs.push(`tz="${escapeXmlAttr(normalized.tz)}"`);
  if (normalized.format) attrs.push(`format="${escapeXmlAttr(normalized.format)}"`);
  if (normalized.timeFormat) attrs.push(`time-format="${escapeXmlAttr(normalized.timeFormat)}"`);
  if (normalized.reminder) attrs.push(`reminder="${escapeXmlAttr(normalized.reminder)}"`);
  return attrs.join(" ");
}

export function formatDateMentionDisplay(
  input: Partial<NfmDateMentionInlineContent> | undefined,
  options: DateMentionFormatOptions = {},
): string {
  const normalized = normalizeDateMention(input);
  if (!normalized) return "Date";
  return `@${formatDateMentionLabel(normalized, { ...options, relative: true })}`;
}

export function formatDateMentionPlainText(
  input: Partial<NfmDateMentionInlineContent> | undefined,
  options: DateMentionFormatOptions = {},
): string {
  const normalized = normalizeDateMention(input);
  if (!normalized) return "@Date";
  return `@${formatDateMentionLabel(normalized, { ...options, relative: false })}`;
}

export function formatDateMentionLabel(
  input: NfmDateMentionInlineContent,
  options: DateMentionFormatOptions = {},
): string {
  const normalized = normalizeDateMention(input);
  if (!normalized) return "Date";

  const startParts = parseDateMentionValue(normalized.start);
  if (!startParts) return "Date";

  const formatOptions = { ...options, now: options.now ?? new Date() };
  const startLabel = formatDateMentionEndpoint(startParts, normalized, formatOptions);
  if (!normalized.end) return startLabel;

  const endParts = parseDateMentionValue(normalized.end);
  if (!endParts) return startLabel;

  const endLabel = formatDateMentionEndpoint(endParts, normalized, formatOptions);
  return `${startLabel} → ${endLabel}`;
}

export function buildDateMentionQueryMatches(
  query: string,
  now = new Date(),
): DateMentionQueryMatch[] {
  const normalizedQuery = normalizeQuery(query);
  const today = todayIsoDate(now);
  const tomorrow = addIsoDateDays(today, 1);
  const yesterday = addIsoDateDays(today, -1);
  const localTimeZone = getLocalDateMentionTimeZone();
  const nowPayload = createDateMentionPayload(
    createDateMentionDateTimeValue(today, currentIsoTime(now), localTimeZone),
    { tz: localTimeZone },
  );
  const matches: DateMentionQueryMatch[] = [
    {
      key: "date:today",
      title: "Today",
      subtext: formatDateMentionPlainText(createDateMentionPayload(today), { now }),
      aliases: ["today", "date"],
      payload: createDateMentionPayload(today),
      group: "Dates",
      priority: 10,
    },
    {
      key: "date:tomorrow",
      title: "Tomorrow",
      subtext: formatDateMentionPlainText(createDateMentionPayload(tomorrow), { now }),
      aliases: ["tomorrow"],
      payload: createDateMentionPayload(tomorrow),
      group: "Dates",
      priority: 20,
    },
    {
      key: "date:yesterday",
      title: "Yesterday",
      subtext: formatDateMentionPlainText(createDateMentionPayload(yesterday), { now }),
      aliases: ["yesterday"],
      payload: createDateMentionPayload(yesterday),
      group: "Dates",
      priority: 30,
    },
    {
      key: "date:now",
      title: "Now",
      subtext: formatDateMentionPlainText(nowPayload, { now }),
      aliases: ["now"],
      payload: nowPayload,
      group: "Dates",
      priority: 5,
    },
    {
      key: "reminder:today",
      title: "Remind today",
      subtext: "Inline date reminder at 9:00 AM",
      aliases: ["remind today", "reminder today"],
      payload: createDateMentionPayload(today, { reminder: "day:0@09:00" }),
      group: "Reminders",
      priority: 40,
    },
    {
      key: "reminder:tomorrow",
      title: "Remind tomorrow",
      subtext: "Inline date reminder at 9:00 AM",
      aliases: ["remind tomorrow", "reminder tomorrow"],
      payload: createDateMentionPayload(tomorrow, { reminder: "day:1@09:00" }),
      group: "Reminders",
      priority: 41,
    },
  ];

  const parsedDate = parseLooseDateQuery(normalizedQuery, now);
  if (parsedDate) {
    matches.push({
      key: `date:manual:${parsedDate}`,
      title: formatDateMentionLabel(createDateMentionPayload(parsedDate), { now, relative: true }),
      subtext: formatDateMentionPlainText(createDateMentionPayload(parsedDate), { now }),
      aliases: [normalizedQuery],
      payload: createDateMentionPayload(parsedDate),
      group: "Dates",
      priority: 1,
    });
  }

  if (!normalizedQuery)
    return matches.filter((match) => match.key === "date:today" || match.key === "date:now");

  return matches
    .filter((match) => {
      const haystack = [match.title, ...match.aliases].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .sort((a, b) => a.priority - b.priority);
}

export function parseDateMentionInput(query: string, now = new Date()): string | null {
  return parseLooseDateQuery(normalizeQuery(query), now);
}

export function isDateMentionQuery(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return false;
  if (parseLooseDateQuery(normalized, new Date())) return true;
  return /\b(today|tomorrow|yesterday|now|remind|reminder|date)\b/.test(normalized);
}

export function getReminderLabel(reminder: string | undefined): string {
  if (!reminder) return "None";
  if (reminder === "minute:0") return "At time of event";
  if (reminder === "minute:10") return "10 minutes before";
  if (reminder === "minute:30") return "30 minutes before";
  if (reminder === "hour:1") return "1 hour before";
  if (reminder === "day:0@09:00") return "On day of event at 9:00 AM";
  if (reminder === "day:1@09:00") return "1 day before at 9:00 AM";
  return "Custom reminder";
}

export function getDateFormatLabel(format: NfmDateMentionDateFormat | undefined): string {
  if (!format || format === "relative") return "Relative";
  if (format === "ll") return "Month D, YYYY";
  return format;
}

export function getTimeFormatLabel(format: NfmDateMentionTimeFormat | undefined): string {
  if (!format) return "Locale default";
  if (format === "12h") return "12 hour";
  return "24 hour";
}

function normalizeDateFormat(
  value: NfmDateMentionDateFormat | undefined,
): NfmDateMentionDateFormat | undefined {
  if (!value) return undefined;
  return NFM_DATE_MENTION_DATE_FORMATS.includes(value) ? value : undefined;
}

function normalizeTimeFormat(
  value: NfmDateMentionTimeFormat | undefined,
): NfmDateMentionTimeFormat | undefined {
  if (!value) return undefined;
  return NFM_DATE_MENTION_TIME_FORMATS.includes(value) ? value : undefined;
}

function normalizeReminder(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTimeZone(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUtcOffset(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !UTC_OFFSET_RE.test(trimmed)) return null;
  return trimmed.toUpperCase() === "Z" ? "Z" : trimmed;
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const match = value.match(ISO_DATE_RE);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function formatDateMentionEndpoint(
  value: ParsedDateMentionValue,
  payload: NfmDateMentionInlineContent,
  options: DateMentionFormatOptions,
): string {
  const dateLabel = formatDatePart(value.date, payload.format, options);
  if (!value.time) return dateLabel;

  const timeLabel = formatTimePart(value.time, payload.timeFormat, options.locale ?? "en-US");
  const isRelative =
    (!payload.format || payload.format === "relative") && options.relative !== false;
  if (isRelative && value.date === todayIsoDate(options.now)) return timeLabel;

  return `${dateLabel} ${timeLabel}`;
}

function formatDatePart(
  value: string,
  format: NfmDateMentionDateFormat | undefined,
  options: DateMentionFormatOptions,
): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  const effectiveFormat = format ?? "relative";
  if (effectiveFormat === "relative" && options.relative !== false) {
    return formatRelativeDate(value, options.now ?? new Date(), options.locale ?? "en-US");
  }

  const parts = splitIsoDate(value);
  if (!parts) return value;
  if (effectiveFormat === "MM/DD/YYYY")
    return `${pad2(parts.month)}/${pad2(parts.day)}/${parts.year}`;
  if (effectiveFormat === "DD/MM/YYYY")
    return `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`;
  if (effectiveFormat === "YYYY/MM/DD")
    return `${parts.year}/${pad2(parts.month)}/${pad2(parts.day)}`;

  return new Intl.DateTimeFormat(options.locale ?? "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatRelativeDate(value: string, now: Date, locale: string): string {
  const target = parseIsoDate(value);
  if (!target) return value;
  const current = parseIsoDate(todayIsoDate(now));
  if (!current) return formatDatePart(value, "ll", { locale, relative: false });
  const diff = Math.round(
    (startOfDay(target).getTime() - startOfDay(current).getTime()) / 86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(target);
  if (diff > 1 && diff <= 6) return `Next ${weekday}`;
  if (diff < -1 && diff >= -6) return `Last ${weekday}`;
  return formatDatePart(value, "ll", { locale, relative: false });
}

function formatTimePart(
  value: string,
  format: NfmDateMentionTimeFormat | undefined,
  locale: string,
): string {
  const [hourPart, minutePart] = value.split(":");
  const hour = Number.parseInt(hourPart ?? "", 10);
  const minute = Number.parseInt(minutePart ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  if (format === "24h") return `${pad2(hour)}:${pad2(minute)}`;
  const date = new Date(2000, 0, 1, hour, minute);
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: format === "12h" ? true : undefined,
  }).format(date);
}

function splitIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(ISO_DATE_RE);
  if (!match) return null;
  return {
    year: Number.parseInt(match[1] ?? "", 10),
    month: Number.parseInt(match[2] ?? "", 10),
    day: Number.parseInt(match[3] ?? "", 10),
  };
}

function repairDateMentionRange(
  start: string,
  end: string,
  kind: NfmDateMentionValueKind,
): { start: string; end: string } {
  if (kind === "date") {
    return start <= end ? { start, end } : { start: end, end: start };
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return startMs <= endMs ? { start, end } : { start: end, end: start };
  }

  return start <= end ? { start, end } : { start: end, end: start };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLooseDateQuery(query: string, now: Date): string | null {
  if (!query) return null;
  if (parseIsoDate(query)) return query;

  const slashMatch = query.match(SHORT_US_DATE_RE);
  if (slashMatch) {
    const month = Number.parseInt(slashMatch[1] ?? "", 10);
    const day = Number.parseInt(slashMatch[2] ?? "", 10);
    const year = normalizeQueryYear(slashMatch[3], now);
    const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
    return isValidIsoDate(candidate) ? candidate : null;
  }

  const monthNameMatch = query.match(MONTH_NAME_DATE_RE);
  if (monthNameMatch) {
    const monthName = monthNameMatch[1]?.toLowerCase() ?? "";
    const monthIndex = MONTH_INDEX_BY_NAME.get(monthName);
    if (monthIndex === undefined) return null;
    const day = Number.parseInt(monthNameMatch[2] ?? "", 10);
    const year = normalizeQueryYear(monthNameMatch[3], now);
    const candidate = `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
    return isValidIsoDate(candidate) ? candidate : null;
  }

  return null;
}

function normalizeQueryYear(value: string | undefined, now: Date): number {
  if (!value) return now.getFullYear();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return now.getFullYear();
  return value.length === 2 ? 2000 + parsed : parsed;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/^@/, "").replace(/\s+/g, " ").toLowerCase();
}

function getLocalUtcOffsetForDateTime(date: string, time: string): string {
  const dateParts = splitIsoDate(date);
  const timeMatch = time.match(TIME_RE);
  if (!dateParts || !timeMatch) return getLocalUtcOffset();
  const hour = Number.parseInt(timeMatch[1] ?? "", 10);
  const minute = Number.parseInt(timeMatch[2] ?? "", 10);
  const localDate = new Date(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute);
  return minutesToUtcOffset(-localDate.getTimezoneOffset());
}

function getLocalUtcOffset(now = new Date()): string {
  return minutesToUtcOffset(-now.getTimezoneOffset());
}

function getUtcOffsetForTimeZone(date: string, time: string, timeZone: string): string | null {
  if (timeZone === "UTC") return "Z";
  const dateParts = splitIsoDate(date);
  const timeMatch = time.match(TIME_RE);
  if (!dateParts || !timeMatch) return null;

  const hour = Number.parseInt(timeMatch[1] ?? "", 10);
  const minute = Number.parseInt(timeMatch[2] ?? "", 10);
  const utcGuess = new Date(
    Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, 0),
  );

  try {
    const formattedParts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(utcGuess);
    const localYear = getFormattedPart(formattedParts, "year");
    const localMonth = getFormattedPart(formattedParts, "month");
    const localDay = getFormattedPart(formattedParts, "day");
    const localHour = getFormattedPart(formattedParts, "hour");
    const localMinute = getFormattedPart(formattedParts, "minute");
    const localSecond = getFormattedPart(formattedParts, "second");
    if (!localYear || !localMonth || !localDay || !localHour || !localMinute || !localSecond) {
      return null;
    }
    const localAsUtc = Date.UTC(
      Number.parseInt(localYear, 10),
      Number.parseInt(localMonth, 10) - 1,
      Number.parseInt(localDay, 10),
      Number.parseInt(localHour, 10),
      Number.parseInt(localMinute, 10),
      Number.parseInt(localSecond, 10),
    );
    const offsetMinutes = Math.round((localAsUtc - utcGuess.getTime()) / 60_000);
    return minutesToUtcOffset(offsetMinutes);
  } catch {
    return null;
  }
}

function getFormattedPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | null {
  return parts.find((part) => part.type === type)?.value ?? null;
}

function minutesToUtcOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const mins = absolute % 60;
  return `${sign}${pad2(hours)}:${pad2(mins)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
