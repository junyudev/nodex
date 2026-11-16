import { defineMessages, type MessageDescriptor } from "../i18n/messages";

export interface DateMentionInlineContent {
  type: "dateMention";
  start: string;
  end?: string;
  tz?: string;
  format?: DateMentionDateFormat;
  timeFormat?: DateMentionTimeFormat;
  reminder?: string;
}
export type DateMentionValueKind = "date" | "datetime";
export type DateMentionDateFormat = "relative" | "ll" | "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD";
export type DateMentionTimeFormat = "12h" | "24h";

export interface ParsedDateMentionValue {
  kind: DateMentionValueKind;
  value: string;
  date: string;
  time?: string;
  offset?: string;
}

export const DATE_MENTION_DATE_FORMATS: DateMentionDateFormat[] = [
  "relative",
  "ll",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "YYYY/MM/DD",
];

export const DATE_MENTION_TIME_FORMATS: DateMentionTimeFormat[] = ["12h", "24h"];

export const DATE_MENTION_REMINDER_PRESETS = [
  "minute:0",
  "minute:10",
  "minute:30",
  "hour:1",
  "day:0@09:00",
  "day:1@09:00",
] as const;

export interface DateMentionFormatOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
  relative?: boolean;
}

export interface DateMentionFormatter {
  readonly locale: string;
  formatMessage(message: MessageDescriptor, values?: Record<string, string>): string;
}

type DateMentionDisplayOptions = DateMentionFormatOptions & {
  readonly formatter?: DateMentionFormatter;
};

export interface DateMentionQueryMatch {
  key: string;
  title: string;
  subtext: string;
  aliases: string[];
  payload: DateMentionInlineContent;
  group: "Dates" | "Reminders";
  priority: number;
}

export const DATE_MENTION_LABEL_MESSAGES = defineMessages({
  date: { id: "shared.dateMention.date", defaultMessage: "Date" },
  today: { id: "shared.dateMention.today", defaultMessage: "Today" },
  tomorrow: { id: "shared.dateMention.tomorrow", defaultMessage: "Tomorrow" },
  yesterday: { id: "shared.dateMention.yesterday", defaultMessage: "Yesterday" },
  now: { id: "shared.dateMention.now", defaultMessage: "Now" },
  nextWeekday: { id: "shared.dateMention.nextWeekday", defaultMessage: "Next {weekday}" },
  lastWeekday: { id: "shared.dateMention.lastWeekday", defaultMessage: "Last {weekday}" },
  remindToday: { id: "shared.dateMention.remindToday", defaultMessage: "Remind today" },
  remindTomorrow: { id: "shared.dateMention.remindTomorrow", defaultMessage: "Remind tomorrow" },
  inlineReminder: {
    id: "shared.dateMention.inlineReminder",
    defaultMessage: "Inline date reminder at 9:00 AM",
  },
  Dates: { id: "shared.dateMention.dates", defaultMessage: "Dates" },
  Reminders: { id: "shared.dateMention.reminders", defaultMessage: "Reminders" },
});

export const DATE_MENTION_REMINDER_MESSAGES = defineMessages({
  none: { id: "shared.dateMention.noReminder", defaultMessage: "None" },
  "minute:0": { id: "shared.dateMention.atEvent", defaultMessage: "At time of event" },
  "minute:10": { id: "shared.dateMention.tenMinutesBefore", defaultMessage: "10 minutes before" },
  "minute:30": {
    id: "shared.dateMention.thirtyMinutesBefore",
    defaultMessage: "30 minutes before",
  },
  "hour:1": { id: "shared.dateMention.oneHourBefore", defaultMessage: "1 hour before" },
  "day:0@09:00": { id: "shared.dateMention.sameDay", defaultMessage: "On day of event at 9:00 AM" },
  "day:1@09:00": { id: "shared.dateMention.dayBefore", defaultMessage: "1 day before at 9:00 AM" },
  custom: { id: "shared.dateMention.customReminder", defaultMessage: "Custom reminder" },
});

export const DATE_MENTION_FORMAT_MESSAGES = defineMessages({
  relative: { id: "shared.dateMention.relative", defaultMessage: "Relative" },
  ll: {
    id: "shared.dateMention.longDateFormat",
    defaultMessage: "Month D, YYYY",
    description: "Example format, not a formatted date",
  },
  locale: { id: "shared.dateMention.localeDefault", defaultMessage: "Locale default" },
  "12h": { id: "shared.dateMention.twelveHour", defaultMessage: "12 hour" },
  "24h": { id: "shared.dateMention.twentyFourHour", defaultMessage: "24 hour" },
});

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

export function normalizeDateMention(
  input: Partial<DateMentionInlineContent> | undefined,
): DateMentionInlineContent | null {
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
    format?: DateMentionDateFormat;
    timeFormat?: DateMentionTimeFormat;
    reminder?: string;
  } = {},
): DateMentionInlineContent {
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

export function formatDateMentionDisplay(
  input: Partial<DateMentionInlineContent> | undefined,
  options: DateMentionFormatOptions = {},
): string {
  const normalized = normalizeDateMention(input);
  if (!normalized) return "Date";
  return `@${formatDateMentionLabel(normalized, { ...options, relative: true })}`;
}

export function formatDateMentionPlainText(
  input: Partial<DateMentionInlineContent> | undefined,
  options: DateMentionFormatOptions = {},
): string {
  const normalized = normalizeDateMention(input);
  if (!normalized) return "@Date";
  return `@${formatDateMentionLabel(normalized, { ...options, relative: false })}`;
}

export function formatDateMentionLabel(
  input: DateMentionInlineContent,
  options: DateMentionFormatOptions = {},
): string {
  return formatDateMentionLabelWithOptions(input, options);
}

export function formatLocalizedDateMentionLabel(
  input: DateMentionInlineContent,
  formatter: DateMentionFormatter,
  options: Omit<DateMentionFormatOptions, "locale"> = {},
): string {
  return formatDateMentionLabelWithOptions(input, {
    ...options,
    locale: formatter.locale,
    formatter,
  });
}

function formatDateMentionLabelWithOptions(
  input: DateMentionInlineContent,
  options: DateMentionDisplayOptions,
): string {
  const normalized = normalizeDateMention(input);
  const startParts = normalized ? parseDateMentionValue(normalized.start) : null;
  if (!normalized || !startParts) {
    return options.formatter?.formatMessage(DATE_MENTION_LABEL_MESSAGES.date) ?? "Date";
  }

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
  return buildDateMentionMatches(query, now);
}

export function buildLocalizedDateMentionQueryMatches(
  query: string,
  formatter: DateMentionFormatter,
  now = new Date(),
): DateMentionQueryMatch[] {
  return buildDateMentionMatches(query, now, formatter);
}

function buildDateMentionMatches(
  query: string,
  now: Date,
  formatter?: DateMentionFormatter,
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
  const formatOptions = { now, locale: formatter?.locale, formatter };
  const labels = DATE_MENTION_LABEL_MESSAGES;
  const matches: DateMentionQueryMatch[] = [
    {
      key: "date:today",
      title: formatter?.formatMessage(labels.today) ?? "Today",
      subtext: formatDateMentionPlainText(createDateMentionPayload(today), formatOptions),
      aliases: ["today", "date"],
      payload: createDateMentionPayload(today),
      group: "Dates",
      priority: 10,
    },
    {
      key: "date:tomorrow",
      title: formatter?.formatMessage(labels.tomorrow) ?? "Tomorrow",
      subtext: formatDateMentionPlainText(createDateMentionPayload(tomorrow), formatOptions),
      aliases: ["tomorrow"],
      payload: createDateMentionPayload(tomorrow),
      group: "Dates",
      priority: 20,
    },
    {
      key: "date:yesterday",
      title: formatter?.formatMessage(labels.yesterday) ?? "Yesterday",
      subtext: formatDateMentionPlainText(createDateMentionPayload(yesterday), formatOptions),
      aliases: ["yesterday"],
      payload: createDateMentionPayload(yesterday),
      group: "Dates",
      priority: 30,
    },
    {
      key: "date:now",
      title: formatter?.formatMessage(labels.now) ?? "Now",
      subtext: formatDateMentionPlainText(nowPayload, formatOptions),
      aliases: ["now"],
      payload: nowPayload,
      group: "Dates",
      priority: 5,
    },
    {
      key: "reminder:today",
      title: formatter?.formatMessage(labels.remindToday) ?? "Remind today",
      subtext: formatter?.formatMessage(labels.inlineReminder) ?? "Inline date reminder at 9:00 AM",
      aliases: ["remind today", "reminder today"],
      payload: createDateMentionPayload(today, { reminder: "day:0@09:00" }),
      group: "Reminders",
      priority: 40,
    },
    {
      key: "reminder:tomorrow",
      title: formatter?.formatMessage(labels.remindTomorrow) ?? "Remind tomorrow",
      subtext: formatter?.formatMessage(labels.inlineReminder) ?? "Inline date reminder at 9:00 AM",
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
      title: formatDateMentionLabelWithOptions(createDateMentionPayload(parsedDate), formatOptions),
      subtext: formatDateMentionPlainText(createDateMentionPayload(parsedDate), formatOptions),
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

export function getReminderLabelMessage(reminder: string | undefined): MessageDescriptor {
  const messages = DATE_MENTION_REMINDER_MESSAGES;
  if (!reminder) return messages.none;
  const preset = DATE_MENTION_REMINDER_PRESETS.find((value) => value === reminder);
  return preset ? messages[preset] : messages.custom;
}

export function getDateFormatLabel(format: DateMentionDateFormat | undefined): string {
  if (!format || format === "relative") return "Relative";
  if (format === "ll") return "Month D, YYYY";
  return format;
}

export function getDateFormatLabelMessage(
  format: DateMentionDateFormat | undefined,
): MessageDescriptor | null {
  if (!format || format === "relative") return DATE_MENTION_FORMAT_MESSAGES.relative;
  if (format === "ll") return DATE_MENTION_FORMAT_MESSAGES.ll;
  return null;
}

export function getTimeFormatLabel(format: DateMentionTimeFormat | undefined): string {
  if (!format) return "Locale default";
  if (format === "12h") return "12 hour";
  return "24 hour";
}

export function getTimeFormatLabelMessage(
  format: DateMentionTimeFormat | undefined,
): MessageDescriptor {
  return DATE_MENTION_FORMAT_MESSAGES[format ?? "locale"];
}

function normalizeDateFormat(
  value: DateMentionDateFormat | undefined,
): DateMentionDateFormat | undefined {
  if (!value) return undefined;
  return DATE_MENTION_DATE_FORMATS.includes(value) ? value : undefined;
}

function normalizeTimeFormat(
  value: DateMentionTimeFormat | undefined,
): DateMentionTimeFormat | undefined {
  if (!value) return undefined;
  return DATE_MENTION_TIME_FORMATS.includes(value) ? value : undefined;
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
  payload: DateMentionInlineContent,
  options: DateMentionDisplayOptions,
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
  format: DateMentionDateFormat | undefined,
  options: DateMentionDisplayOptions,
): string {
  const date = parseIsoDate(value);
  if (!date) return value;
  const effectiveFormat = format ?? "relative";
  if (effectiveFormat === "relative" && options.relative !== false) {
    return formatRelativeDate(
      value,
      options.now ?? new Date(),
      options.locale ?? "en-US",
      options.formatter,
    );
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

function formatRelativeDate(
  value: string,
  now: Date,
  locale: string,
  formatter: DateMentionFormatter | undefined,
): string {
  const target = parseIsoDate(value);
  if (!target) return value;
  const current = parseIsoDate(todayIsoDate(now));
  if (!current) return formatDatePart(value, "ll", { locale, relative: false });
  const diff = Math.round(
    (startOfDay(target).getTime() - startOfDay(current).getTime()) / 86_400_000,
  );
  const labels = DATE_MENTION_LABEL_MESSAGES;
  if (diff === 0) return formatter?.formatMessage(labels.today) ?? "Today";
  if (diff === 1) return formatter?.formatMessage(labels.tomorrow) ?? "Tomorrow";
  if (diff === -1) return formatter?.formatMessage(labels.yesterday) ?? "Yesterday";
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(target);
  if (diff > 1 && diff <= 6) {
    return formatter?.formatMessage(labels.nextWeekday, { weekday }) ?? `Next ${weekday}`;
  }
  if (diff < -1 && diff >= -6) {
    return formatter?.formatMessage(labels.lastWeekday, { weekday }) ?? `Last ${weekday}`;
  }
  return formatDatePart(value, "ll", { locale, relative: false });
}

function formatTimePart(
  value: string,
  format: DateMentionTimeFormat | undefined,
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
  kind: DateMentionValueKind,
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
