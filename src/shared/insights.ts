/** What Insights reads and shows. Transport-neutral: Agent Runtime, Main and renderer share these. */

export type InsightsOrigin = "all" | "nodex";

/** A provider home whose transcripts count toward Insights. `nodex` homes hold only Nodex's own work. */
export interface InsightsUsageSource {
  readonly provider: "claude" | "codex";
  readonly home: string;
  readonly origin: "nodex" | "external";
}

export type InsightsHistoryAccess = "unset" | "granted";

export interface InsightsModelDay {
  /** Calendar day in the requested time zone, `YYYY-MM-DD`. */
  readonly day: string;
  readonly provider: "claude" | "codex";
  readonly model: string;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly requests: number;
  /** At API list price. Zero for a model without a known price, which `priced` tells apart. */
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly priced: boolean;
}

export interface InsightsAgentDay {
  readonly day: string;
  readonly turns: number;
  readonly activeSeconds: number;
  /** The most agents working at one moment of this day. */
  readonly peakAgents: number;
}

export interface InsightsScanProgress {
  readonly state: "idle" | "scanning";
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly failedFiles: number;
  /** When the last full pass finished, or null before the first one has. */
  readonly finishedAtMs: number | null;
}

export type InsightsPricingStatus = "fresh" | "cached" | "unavailable";

export interface InsightsUsageSnapshot {
  readonly access: InsightsHistoryAccess;
  /** Advances whenever the numbers below may have changed. */
  readonly revision: number;
  readonly scan: InsightsScanProgress;
  readonly pricing: InsightsPricingStatus;
  readonly models: readonly InsightsModelDay[];
  readonly messages: readonly (readonly [day: string, count: number])[];
  readonly conversations: readonly (readonly [day: string, count: number])[];
  /** Sparse: a day and hour with no tokens is absent. */
  readonly hours: readonly (readonly [day: string, hour: number, tokens: number])[];
  readonly agents: readonly InsightsAgentDay[];
}

export interface InsightsContentSnapshot {
  readonly pageTotal: number;
  readonly blockTotal: number;
  readonly taskTotal: number;
  readonly tasksDoneTotal: number;
  readonly pagesCreated: readonly (readonly [day: string, count: number])[];
  readonly tasksDone: readonly (readonly [day: string, count: number])[];
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;

/** A rollup slot is a UTC quarter hour, so any IANA zone can bucket it into its own calendar. */
export const usageSlotOf = (timestampMs: number) => Math.floor(timestampMs / QUARTER_HOUR_MS);
export const usageSlotStartMs = (slot: number) => slot * QUARTER_HOUR_MS;

export interface LocalCalendar {
  readonly dayOf: (timestampMs: number) => string;
  readonly hourOf: (timestampMs: number) => number;
}

/** Quarter hours repeat across a large read, so each one is formatted once. */
export function localCalendar(timeZone: string): LocalCalendar {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  const hourOptions = { hour: "2-digit", hourCycle: "h23" } as const;
  let dayFormat: Intl.DateTimeFormat;
  let hourFormat: Intl.DateTimeFormat;
  try {
    dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone, ...options });
    hourFormat = new Intl.DateTimeFormat("en-US", { timeZone, ...hourOptions });
  } catch {
    dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...options });
    hourFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...hourOptions });
  }
  const days = new Map<number, string>();
  const hours = new Map<number, number>();
  return {
    dayOf: (timestampMs) => {
      const slot = usageSlotOf(timestampMs);
      let day = days.get(slot);
      if (day === undefined) {
        day = dayFormat.format(new Date(slot * QUARTER_HOUR_MS));
        days.set(slot, day);
      }
      return day;
    },
    hourOf: (timestampMs) => {
      const slot = usageSlotOf(timestampMs);
      let hour = hours.get(slot);
      if (hour === undefined) {
        hour = Number(hourFormat.format(new Date(slot * QUARTER_HOUR_MS))) % 24;
        hours.set(slot, hour);
      }
      return hour;
    },
  };
}
