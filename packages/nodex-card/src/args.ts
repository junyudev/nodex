import { parseArgs } from "node:util";

import { terminal, type Locale } from "./locale";
import { MAX_NAME_LENGTH } from "./page/data";

const options = {
  year: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  "no-cost": { type: "boolean" },
  name: { type: "string" },
  "no-open": { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
} as const;

export class ArgumentError extends Error {}

function dayOption(value: string, flag: string, locale: Locale): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000") ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new ArgumentError(terminal[locale].invalidDate(flag));
  }
  return value;
}

export function localToday(now = new Date()): string {
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function resolveArgs(args: readonly string[], today: string, locale: Locale) {
  const messages = terminal[locale];
  const values = (() => {
    try {
      return parseArgs({ args: [...args], options }).values;
    } catch (error) {
      const detail = locale === "en-US" && error instanceof Error ? ` ${error.message}` : "";
      throw new ArgumentError(messages.invalidArguments + detail, { cause: error });
    }
  })();

  if (values.help) return { command: "help" } as const;
  if (values.version) return { command: "version" } as const;

  const name = values.name ?? "";
  if (name.length > MAX_NAME_LENGTH) throw new ArgumentError(messages.longName);

  const currentYear = today.slice(0, 4);
  const year = values.year ?? currentYear;
  const customRange = values.since !== undefined || values.until !== undefined;

  if (values.year !== undefined && customRange) {
    throw new ArgumentError(messages.conflictingDates);
  }
  if (!/^\d{4}$/.test(year) || year === "0000") {
    throw new ArgumentError(messages.invalidYear);
  }
  if (year > currentYear) throw new ArgumentError(messages.futureYear);

  const endOfYear = year === currentYear ? today : `${year}-12-31`;
  const lastDay =
    values.until === undefined ? endOfYear : dayOption(values.until, "--until", locale);
  const firstDay =
    values.since === undefined
      ? `${lastDay.slice(0, 4)}-01-01`
      : dayOption(values.since, "--since", locale);

  if (firstDay > lastDay) throw new ArgumentError(messages.reversedDates);

  return {
    command: "preview",
    period: customRange ? "range" : "year",
    firstDay,
    lastDay,
    name,
    cost: !values["no-cost"],
    open: !values["no-open"],
  } as const;
}
