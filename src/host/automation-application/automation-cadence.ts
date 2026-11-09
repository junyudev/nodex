// This is the heartbeat cooldown duration, never the authority for the next clock occurrence.
const BASIC_INTERVAL_KEYS = new Set(["FREQ", "INTERVAL", "DTSTART", "TZID"]);
const HOURLY_INTERVAL_KEYS = new Set([...BASIC_INTERVAL_KEYS, "BYDAY", "BYMINUTE"]);
const WEEKDAY_TO_JS_DAY: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
};
export function computeAutomationIntervalMs(rrule: string | null | undefined): number | null {
  const options = parseRruleParts(rrule);
  const freq = options.get("FREQ");
  const interval = parsePositiveInteger(options.get("INTERVAL")) ?? 1;

  if (freq === "MINUTELY" && hasOnlyKeys(options, BASIC_INTERVAL_KEYS)) {
    return interval * 60_000;
  }

  if (freq !== "HOURLY" || !hasOnlyKeys(options, HOURLY_INTERVAL_KEYS)) return null;

  const byMinute = parseIntegerList(options.get("BYMINUTE"));
  if (byMinute.length > 0 && (byMinute.length !== 1 || byMinute[0] !== 0)) return null;

  const byDay = parseWeekdayList(options.get("BYDAY"));
  if (options.has("BYDAY") && byDay.length !== 7) return null;

  return interval * 60 * 60_000;
}

function parseRruleParts(rrule: string | null | undefined): Map<string, string> {
  const text = rrule?.trim() ?? "";
  const options = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const upper = trimmed.toUpperCase();
    if (upper.startsWith("DTSTART")) {
      continue;
    }

    const ruleBody = upper.startsWith("RRULE:") ? trimmed.slice(trimmed.indexOf(":") + 1) : trimmed;
    for (const part of ruleBody.split(";")) {
      const [rawKey, ...rawValueParts] = part.split("=");
      const key = rawKey?.trim().toUpperCase();
      const value = rawValueParts.join("=").trim().toUpperCase();
      if (!key || !value) continue;
      options.set(key, value);
    }
  }

  return options;
}

function hasOnlyKeys(options: Map<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  for (const key of options.keys()) {
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

function parseWeekdayList(value: string | undefined): number[] {
  if (!value) return [];
  const weekdays: number[] = [];
  for (const part of value.split(",")) {
    const weekday = WEEKDAY_TO_JS_DAY[part.trim().slice(-2)];
    if (weekday === undefined || weekdays.includes(weekday)) continue;
    weekdays.push(weekday);
  }
  return weekdays;
}

function parseIntegerList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isInteger(part));
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
