import { rrulestr, type RRule, type RRuleSet } from "rrule";
import {
  normalizeCodexScheduledAutomationRruleText,
  parseCodexScheduledAutomationRruleFields,
} from "@/lib/codex-scheduled-automation-rrule";
import { DEFAULT_WORKBENCH_AUTOMATION_RRULE } from "./workbench-automation-draft";

export type WorkbenchAutomationScheduleMode = "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type WorkbenchAutomationScheduleIntervalStyle = "default" | "heartbeat";
export type WorkbenchAutomationWeekdayCode = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export interface WorkbenchAutomationScheduleConfig {
  mode: WorkbenchAutomationScheduleMode;
  intervalHours: number;
  intervalMinutes: number | null;
  weekdays: WorkbenchAutomationWeekdayCode[];
  time: string;
  customRrule: string;
}

export const DEFAULT_WORKBENCH_AUTOMATION_SCHEDULE_TIME = "09:00";
export const WORKBENCH_AUTOMATION_ALL_WEEKDAYS: WorkbenchAutomationWeekdayCode[] = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
];
export const WORKBENCH_AUTOMATION_WEEKDAYS: WorkbenchAutomationWeekdayCode[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
];

const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;
const RRULE_WEEKDAY_TO_CODE: Record<number, WorkbenchAutomationWeekdayCode> = {
  0: "MO",
  1: "TU",
  2: "WE",
  3: "TH",
  4: "FR",
  5: "SA",
  6: "SU",
};
const WEEKDAY_INDEX = new Map(
  WORKBENCH_AUTOMATION_ALL_WEEKDAYS.map((weekday, index) => [weekday, index]),
);
export const WORKBENCH_AUTOMATION_WEEKDAY_LABELS: Record<WorkbenchAutomationWeekdayCode, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
};

const BASIC_INTERVAL_KEYS = new Set(["freq", "interval"]);
const HOURLY_INTERVAL_KEYS = new Set(["freq", "interval", "byweekday", "byminute"]);

interface ParsedScheduleRrule {
  fields: Map<string, string>;
  origKeys: Set<string>;
  options: RRule["options"];
  isStandaloneRrule: boolean;
}

export function createDefaultWorkbenchAutomationScheduleConfig(
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle,
): WorkbenchAutomationScheduleConfig {
  if (intervalStyle === "heartbeat") {
    return {
      mode: "hourly",
      intervalHours: 1,
      intervalMinutes: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
      weekdays: [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS],
      time: DEFAULT_WORKBENCH_AUTOMATION_SCHEDULE_TIME,
      customRrule: "",
    };
  }

  return {
    mode: "daily",
    intervalHours: 24,
    intervalMinutes: null,
    weekdays: [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS],
    time: DEFAULT_WORKBENCH_AUTOMATION_SCHEDULE_TIME,
    customRrule: "",
  };
}

export function resolveWorkbenchAutomationScheduleConfig(input: {
  rrule: string | null | undefined;
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle;
}): WorkbenchAutomationScheduleConfig {
  const fallback = createDefaultWorkbenchAutomationScheduleConfig(input.intervalStyle);
  const text = normalizeCodexScheduledAutomationRruleText(input.rrule);
  if (!text) return fallback;

  const parsed = parseScheduleRrule(text);
  if (!parsed) {
    return {
      ...fallback,
      mode: "custom",
      customRrule: text,
    };
  }

  const fields = parsed.fields;
  const frequency = fields.get("FREQ") ?? "";
  const interval = parsePositiveInteger(fields.get("INTERVAL")) ?? 1;
  const time = resolveScheduleTime(fields) ?? fallback.time;
  const weekdays = resolveScheduleWeekdays(parsed);
  const hasMultipleTimes = hasMultipleTimeValues(fields);
  const intervalMinutes = resolveIntervalMinutes(parsed);

  if (input.intervalStyle === "heartbeat" && intervalMinutes !== null) {
    return {
      ...fallback,
      mode: "hourly",
      intervalHours: Math.max(1, Math.round(intervalMinutes / 60)),
      intervalMinutes,
      weekdays: [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS],
      time,
    };
  }

  if (frequency === "HOURLY" && intervalMinutes !== null) {
    return {
      ...fallback,
      mode: "hourly",
      intervalHours: Math.max(1, Math.round(intervalMinutes / 60)),
      intervalMinutes: input.intervalStyle === "heartbeat" ? intervalMinutes : null,
      weekdays: [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS],
      time,
    };
  }

  if (hasMultipleTimes || interval !== 1 || (frequency !== "DAILY" && frequency !== "WEEKLY")) {
    return {
      ...fallback,
      mode: "custom",
      customRrule: text,
    };
  }

  if (sameWeekdays(weekdays, WORKBENCH_AUTOMATION_ALL_WEEKDAYS)) {
    return {
      ...fallback,
      mode: "daily",
      weekdays,
      time,
    };
  }

  if (sameWeekdays(weekdays, WORKBENCH_AUTOMATION_WEEKDAYS)) {
    return {
      ...fallback,
      mode: "weekdays",
      weekdays,
      time,
    };
  }

  if (weekdays.length === 1) {
    return {
      ...fallback,
      mode: "weekly",
      weekdays,
      time,
    };
  }

  return {
    ...fallback,
    mode: "custom",
    customRrule: text,
  };
}

export function updateWorkbenchAutomationScheduleConfig(input: {
  config: WorkbenchAutomationScheduleConfig;
  patch: Partial<WorkbenchAutomationScheduleConfig>;
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle;
}): WorkbenchAutomationScheduleConfig {
  const merged = {
    ...input.config,
    ...input.patch,
  };

  if (!input.patch.mode) {
    return normalizeScheduleConfig(merged, input.intervalStyle);
  }

  if (input.patch.mode === "custom") {
    const customRrule =
      input.config.mode === "custom" && input.config.customRrule.trim()
        ? input.config.customRrule
        : buildWorkbenchAutomationScheduleRrule({
            config: input.config,
            intervalStyle: input.intervalStyle,
          });
    return normalizeScheduleConfig(
      {
        ...merged,
        mode: "custom",
        customRrule,
      },
      input.intervalStyle,
    );
  }

  if (input.patch.mode === "hourly") {
    return normalizeScheduleConfig(
      {
        ...merged,
        mode: "hourly",
        intervalHours: sanitizePositiveInteger(input.config.intervalHours, 1),
        intervalMinutes:
          input.intervalStyle === "heartbeat"
            ? sanitizePositiveInteger(
                input.config.intervalMinutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
                DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
              )
            : null,
      },
      input.intervalStyle,
    );
  }

  if (input.patch.mode === "daily") {
    return normalizeScheduleConfig(
      {
        ...merged,
        mode: "daily",
        weekdays: [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS],
      },
      input.intervalStyle,
    );
  }

  if (input.patch.mode === "weekdays") {
    return normalizeScheduleConfig(
      {
        ...merged,
        mode: "weekdays",
        weekdays: [...WORKBENCH_AUTOMATION_WEEKDAYS],
      },
      input.intervalStyle,
    );
  }

  return normalizeScheduleConfig(
    {
      ...merged,
      mode: "weekly",
      weekdays: [normalizeWeekday(input.config.weekdays[0]) ?? "MO"],
    },
    input.intervalStyle,
  );
}

export function buildWorkbenchAutomationScheduleRrule(input: {
  config: WorkbenchAutomationScheduleConfig;
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle;
}): string {
  const config = normalizeScheduleConfig(input.config, input.intervalStyle);
  if (config.mode === "custom") return config.customRrule.trim();

  if (config.mode === "hourly") {
    if (input.intervalStyle === "heartbeat") {
      const minutes = sanitizePositiveInteger(
        config.intervalMinutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
        DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
      );
      return `FREQ=MINUTELY;INTERVAL=${minutes}`;
    }

    const hours = sanitizePositiveInteger(config.intervalHours, 1);
    return `FREQ=HOURLY;INTERVAL=${hours};BYMINUTE=0;BYDAY=${WORKBENCH_AUTOMATION_ALL_WEEKDAYS.join(",")}`;
  }

  const clock =
    parseScheduleTime(config.time) ?? parseScheduleTime(DEFAULT_WORKBENCH_AUTOMATION_SCHEDULE_TIME);
  if (!clock) return DEFAULT_WORKBENCH_AUTOMATION_RRULE;
  const timeParts = `BYHOUR=${clock.hour};BYMINUTE=${clock.minute}`;

  if (config.mode === "daily") return `FREQ=DAILY;${timeParts}`;
  if (config.mode === "weekdays")
    return `FREQ=WEEKLY;BYDAY=${WORKBENCH_AUTOMATION_WEEKDAYS.join(",")};${timeParts}`;

  const weekday = normalizeWeekday(config.weekdays[0]) ?? "MO";
  return `FREQ=WEEKLY;BYDAY=${weekday};${timeParts}`;
}

export function formatWorkbenchAutomationScheduleModeLabel(
  mode: WorkbenchAutomationScheduleMode,
): string {
  if (mode === "hourly") return "Interval";
  if (mode === "daily") return "Daily";
  if (mode === "weekdays") return "Weekdays";
  if (mode === "weekly") return "Weekly";
  return "Custom";
}

export function formatWorkbenchAutomationScheduleLabel(
  config: WorkbenchAutomationScheduleConfig,
): string {
  if (config.mode === "custom") return "Custom schedule";
  if (config.mode === "hourly") {
    const intervalMinutes = config.intervalMinutes ?? config.intervalHours * 60;
    return formatWorkbenchAutomationIntervalLabel(intervalMinutes);
  }

  const timeLabel = formatWorkbenchAutomationScheduleTimeLabel(config.time);
  if (config.mode === "daily") return `Daily at ${timeLabel}`;
  if (config.mode === "weekdays") return `Weekdays at ${timeLabel}`;
  const weekday = normalizeWeekday(config.weekdays[0]) ?? "MO";
  return `${WORKBENCH_AUTOMATION_WEEKDAY_LABELS[weekday]}s at ${timeLabel}`;
}

function parseScheduleRrule(rrule: string): ParsedScheduleRrule | null {
  try {
    const ruleSet = rrulestr(rrule, { forceset: true }) as RRuleSet;
    const rules = ruleSet.rrules();
    const rule = rules[0] ?? null;
    if (!rule || rules.length !== 1) return null;
    if (
      ruleSet.rdates().length !== 0 ||
      ruleSet.exrules().length !== 0 ||
      ruleSet.exdates().length !== 0
    )
      return null;

    const origOptions = normalizeOrigOptions(rule.origOptions as Record<string, unknown>);
    return {
      fields: parseCodexScheduledAutomationRruleFields(rrule),
      origKeys: origOptions,
      options: rule.options,
      isStandaloneRrule: !origOptions.has("dtstart"),
    };
  } catch {
    return null;
  }
}

function normalizeOrigOptions(origOptions: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(origOptions)) {
    if (value === undefined || value === null) continue;
    keys.add(key.toLowerCase());
  }
  return keys;
}

function resolveIntervalMinutes(parsed: ParsedScheduleRrule): number | null {
  if (!parsed.isStandaloneRrule) return null;

  const frequency = parsed.fields.get("FREQ");
  const interval = parsePositiveInteger(parsed.fields.get("INTERVAL")) ?? 1;
  if (frequency === "MINUTELY" && hasOnlyKeys(parsed.origKeys, BASIC_INTERVAL_KEYS))
    return interval;

  if (frequency !== "HOURLY" || !hasOnlyKeys(parsed.origKeys, HOURLY_INTERVAL_KEYS)) return null;

  const byMinute = parseIntegerList(parsed.fields.get("BYMINUTE"));
  if (byMinute.length > 0 && (byMinute.length !== 1 || byMinute[0] !== 0)) return null;

  const weekdays = resolveScheduleWeekdays(parsed);
  if (!sameWeekdays(weekdays, WORKBENCH_AUTOMATION_ALL_WEEKDAYS)) return null;

  return interval * 60;
}

function hasOnlyKeys(keys: Set<string>, allowedKeys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

function resolveScheduleTime(fields: Map<string, string>): string | null {
  const hours = parseIntegerList(fields.get("BYHOUR"));
  const minutes = parseIntegerList(fields.get("BYMINUTE"));
  if (hours.length !== 1 || minutes.length !== 1) return null;

  const hour = hours[0];
  const minute = minutes[0];
  if (hour === undefined || minute === undefined) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return formatClockTime(hour, minute);
}

function resolveScheduleWeekdays(parsed: ParsedScheduleRrule): WorkbenchAutomationWeekdayCode[] {
  const fieldWeekdays = parseWeekdayList(parsed.fields.get("BYDAY"));
  if (fieldWeekdays.length > 0) return fieldWeekdays;

  const optionWeekdays = normalizeRruleOptionWeekdays(parsed.options.byweekday);
  if (optionWeekdays.length > 0) return optionWeekdays;

  if (parsed.fields.get("FREQ") === "WEEKLY") return ["MO"];
  return [...WORKBENCH_AUTOMATION_ALL_WEEKDAYS];
}

function normalizeRruleOptionWeekdays(
  value: number[] | number | null,
): WorkbenchAutomationWeekdayCode[] {
  const values = Array.isArray(value) ? value : value === null ? [] : [value];
  return sortWeekdays(
    values
      .map((weekday) => RRULE_WEEKDAY_TO_CODE[weekday])
      .filter((weekday): weekday is WorkbenchAutomationWeekdayCode => Boolean(weekday)),
  );
}

function parseWeekdayList(value: string | undefined): WorkbenchAutomationWeekdayCode[] {
  if (!value) return [];
  return sortWeekdays(
    value
      .split(",")
      .map((part) => normalizeWeekday(part.trim().slice(-2)))
      .filter((weekday): weekday is WorkbenchAutomationWeekdayCode => weekday !== null),
  );
}

function sortWeekdays(
  weekdays: readonly WorkbenchAutomationWeekdayCode[],
): WorkbenchAutomationWeekdayCode[] {
  return [...new Set(weekdays)].sort(
    (left, right) => (WEEKDAY_INDEX.get(left) ?? 0) - (WEEKDAY_INDEX.get(right) ?? 0),
  );
}

function sameWeekdays(
  left: readonly WorkbenchAutomationWeekdayCode[],
  right: readonly WorkbenchAutomationWeekdayCode[],
): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = sortWeekdays(left);
  const normalizedRight = sortWeekdays(right);
  return normalizedLeft.every((weekday, index) => weekday === normalizedRight[index]);
}

function normalizeScheduleConfig(
  config: WorkbenchAutomationScheduleConfig,
  intervalStyle: WorkbenchAutomationScheduleIntervalStyle,
): WorkbenchAutomationScheduleConfig {
  const fallback = createDefaultWorkbenchAutomationScheduleConfig(intervalStyle);
  const mode = config.mode;
  const time = parseScheduleTime(config.time) ? config.time : fallback.time;
  const weekdays = sortWeekdays(config.weekdays.length > 0 ? config.weekdays : fallback.weekdays);
  return {
    mode,
    intervalHours: sanitizePositiveInteger(config.intervalHours, fallback.intervalHours),
    intervalMinutes:
      config.intervalMinutes === null
        ? null
        : sanitizePositiveInteger(
            config.intervalMinutes,
            fallback.intervalMinutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
          ),
    weekdays,
    time,
    customRrule: config.customRrule,
  };
}

function parseScheduleTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A 24-hour `HH:MM` schedule time as the user reads it, e.g. `9:00 AM`. */
export function formatWorkbenchAutomationScheduleTimeLabel(value: string): string {
  const time =
    parseScheduleTime(value) ?? parseScheduleTime(DEFAULT_WORKBENCH_AUTOMATION_SCHEDULE_TIME);
  if (!time) return "9:00 AM";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2024, 0, 1, time.hour, time.minute));
}

export function formatWorkbenchAutomationIntervalLabel(intervalMinutes: number): string {
  if (intervalMinutes === 1) return "Every minute";
  if (intervalMinutes === 60) return "Hourly";
  if (intervalMinutes === 1_440) return "Daily";
  if (intervalMinutes === 10_080) return "Weekly";
  if (intervalMinutes % 10_080 === 0) return `Every ${intervalMinutes / 10_080} weeks`;
  if (intervalMinutes % 1_440 === 0) return `Every ${intervalMinutes / 1_440} days`;
  if (intervalMinutes % 60 === 0) return `Every ${intervalMinutes / 60} hours`;
  return `Every ${intervalMinutes} minutes`;
}

function hasMultipleTimeValues(fields: Map<string, string>): boolean {
  return (
    parseIntegerList(fields.get("BYHOUR")).length > 1 ||
    parseIntegerList(fields.get("BYMINUTE")).length > 1
  );
}

function parseIntegerList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isInteger(part));
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.round(parsed);
}

function sanitizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.round(value ?? 0);
  return normalized >= 1 ? normalized : fallback;
}

function normalizeWeekday(value: string | undefined): WorkbenchAutomationWeekdayCode | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (
    upper === "SU" ||
    upper === "MO" ||
    upper === "TU" ||
    upper === "WE" ||
    upper === "TH" ||
    upper === "FR" ||
    upper === "SA"
  ) {
    return upper;
  }
  return null;
}
