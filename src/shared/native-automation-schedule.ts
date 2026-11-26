import type { NativeAutomationSchedule } from "./native-automation-import";

const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const cronDays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const cronMonths = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

const invalid = { kind: "unsupported", reason: "invalid" } as const;
const oneShot = { kind: "unsupported", reason: "one-shot" } as const;
const RRULE_MAX_LENGTH = 16 * 1024;

function cronNumber(value: string, min: number, max: number, names: readonly string[]) {
  const named = names.indexOf(value);
  const number = named >= 0 ? named + min : /^\d{1,2}$/u.test(value) ? Number(value) : NaN;
  return number >= min && number <= max ? number : NaN;
}

function cronField(field: string, min: number, max: number, names: readonly string[] = []) {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\*|[A-Z]{3}|\d{1,2})(?:-([A-Z]{3}|\d{1,2}))?(?:\/(\d+))?$/u.exec(part);
    if (!range) return null;
    const [, start, end, step] = range;
    const first = start === "*" ? min : cronNumber(start!, min, max, names);
    const last = end ? cronNumber(end, min, max, names) : start === "*" || step ? max : first;
    const stride = step ? Number(step) : 1;
    if ((start === "*" && end) || !(first <= last) || !Number.isSafeInteger(stride) || stride < 1)
      return null;
    for (let value = first; value <= last; value += stride) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

/** Five-field, minute-precision cron in the host's local timezone. */
export function claudeCronToRrule(expression: string): NativeAutomationSchedule {
  const fields = expression.trim().toUpperCase().split(/\s+/u);
  if (fields.length !== 5 || expression.length > RRULE_MAX_LENGTH) return invalid;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const monthDays = cronField(dayOfMonth, 1, 31);
  const months = cronField(month, 1, 12, cronMonths);
  const weekDays = cronField(dayOfWeek, 0, 7, cronDays);
  if (!minutes || !hours || !monthDays || !months || !weekDays) return invalid;
  // A day field starting with a wildcard intersects the other day field, including steps.
  if (!dayOfMonth.startsWith("*") && !dayOfWeek.startsWith("*"))
    return { kind: "unsupported", reason: "cron-day-or" };

  const parts = [
    "FREQ=DAILY",
    `BYHOUR=${hours.join(",")}`,
    `BYMINUTE=${minutes.join(",")}`,
    "BYSECOND=0",
  ];
  if (monthDays.length < 31) parts.push(`BYMONTHDAY=${monthDays.join(",")}`);
  if (months.length < 12) parts.push(`BYMONTH=${months.join(",")}`);
  const weekdays = new Set(weekDays.map((day) => days[day % 7]));
  if (weekdays.size < 7) parts.push(`BYDAY=${[...weekdays].join(",")}`);
  return { kind: "rrule", rrule: parts.join(";") };
}

const numericOptions: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["BYHOUR", [0, 23]],
  ["BYMINUTE", [0, 59]],
  ["BYSECOND", [0, 59]],
  ["BYMONTH", [1, 12]],
  ["BYMONTHDAY", [-31, 31]],
  ["BYYEARDAY", [-366, 366]],
  ["BYWEEKNO", [-53, 53]],
  ["BYSETPOS", [-366, 366]],
]);

function validRruleField(key: string, value: string) {
  const range = numericOptions.get(key);
  if (range) {
    const [min, max] = range;
    return value.split(",").every((item) => {
      const number = Number(item);
      return (
        /^[+-]?\d+$/u.test(item) && number >= min && number <= max && (min >= 0 || number !== 0)
      );
    });
  }
  switch (key) {
    case "FREQ":
      return /^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)$/u.test(value);
    case "COUNT":
    case "INTERVAL":
      return /^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
    case "BYDAY":
      return value
        .split(",")
        .every((item) =>
          /^(?:[+-]?(?:[1-9]|[1-4][0-9]|5[0-3]))?(SU|MO|TU|WE|TH|FR|SA)$/u.test(item),
        );
    case "WKST":
      return days.includes(value);
    case "UNTIL":
      return /^\d{8}(?:T\d{6}Z?)?$/u.test(value);
    default:
      return false;
  }
}

/** Codex stores a host-local recurrence. Core receives the rule body and a separate timezone. */
export function normalizeCodexAutomationRrule(value: string): NativeAutomationSchedule {
  const body = value
    .trim()
    .toUpperCase()
    .replace(/^RRULE:[ \t]*/u, "");
  if (body.length > RRULE_MAX_LENGTH || /[\r\n]/u.test(body)) return invalid;
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const [key, field, extra] = part.split("=").map((entry) => entry.trim());
    if (!key || !field || extra !== undefined || fields.has(key) || !validRruleField(key, field))
      return invalid;
    fields.set(key, field);
  }
  if (!fields.has("FREQ") || (fields.has("COUNT") && fields.has("UNTIL"))) return invalid;
  if (Number(fields.get("COUNT")) === 1) return oneShot;
  return { kind: "rrule", rrule: [...fields].map(([key, field]) => `${key}=${field}`).join(";") };
}
