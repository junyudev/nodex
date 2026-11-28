/**
 * What a share card draws. Insights projects one from its own ledger; nodex-card projects one
 * from ccusage. A card is a pure function of this view, so whoever produces it gets the same picture.
 */

/**
 * The span a card covers. Insights offers the rolling periods; `year` is one calendar year and
 * `range` any other span, both read from `firstDay` and `lastDay`.
 */
export type ShareCardPeriod = "7d" | "30d" | "90d" | "12m" | "all" | "year" | "range";

export interface ShareCardDay {
  /** `YYYY-MM-DD` in the person's time zone. */
  readonly day: string;
  readonly tokens: number;
}

export interface ShareCardModel {
  readonly label: string;
  readonly tokens: number;
  /** This model's part of all tokens, from 0 to 1. */
  readonly share: number;
  readonly costUsd: number;
}

export interface ShareCardView {
  readonly period: ShareCardPeriod;
  readonly firstDay: string;
  readonly lastDay: string;
  /** Every day of the period, oldest first. */
  readonly days: readonly ShareCardDay[];
  /** Sunday-first weeks of `days`; a null cell lies outside the period. */
  readonly calendar: { readonly weeks: readonly (readonly (ShareCardDay | null)[])[] };
  /** Hour-by-day tokens for the last seven days, oldest first; each row has 24 values. */
  readonly recentHours: readonly { readonly day: string; readonly hours: readonly number[] }[];
  /** Tokens by hour of day, 24 values; all zero when the source cannot tell the hour. */
  readonly hours: readonly number[];
  /** Input, cache reads, cache writes and output together. */
  readonly tokens: number;
  readonly cachedShare: number;
  /** At API list price; zero when unknown or left out. */
  readonly costUsd: number;
  /** What prompt caching saved at list price, or null when the source cannot say. */
  readonly cacheSavingsUsd: number | null;
  readonly activeDays: number;
  readonly longestStreak: number;
  /** Counts a source cannot supply are zero, and a card never shows a zero. */
  readonly messages: number;
  readonly conversations: number;
  readonly peakAgents: number;
  readonly tasksDone: number;
  readonly pagesCreated: number;
  /** Most tokens first. */
  readonly models: readonly ShareCardModel[];
  /** The agents whose history was counted, when the card should name them. */
  readonly sources?: readonly string[];
}
