import { z } from "zod";
import { decodeProductEvent, type ProductEvent } from "../../shared/product-analytics/catalog";
import { STATSIG_CLIENT_KEY } from "../../shared/product-analytics/statsig";

export const PRODUCT_ANALYTICS_STATE_FILE = "product-analytics/state.json";

export const MAX_OUTBOX_EVENTS = 1_000;
export const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const MAX_BATCH_EVENTS = 100;
const FLUSH_AFTER_EVENTS = 25;
const FLUSH_AFTER_AGE_MS = 2 * 60 * 1_000;
/** A person sees the notice and can turn analytics off before anything leaves the machine. */
export const NOTICE_GRACE_MS = 60 * 1_000;
const RETRY_BASE_MS = 60 * 1_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;

export interface OutboxEntry {
  readonly seq: number;
  readonly time: number;
  readonly event: ProductEvent;
}

export interface ProductAnalyticsState {
  readonly installationId: string;
  /** The installation event has been admitted to the outbox once. */
  readonly installationReported: boolean;
  readonly lastLaunchVersion: string | null;
  readonly lastActiveDay: string | null;
  readonly notice: {
    readonly presentedAt: number | null;
    readonly acknowledgedAt: number | null;
  };
  readonly outbox: readonly OutboxEntry[];
}

const StoredState = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.uuid(),
    installationReported: z.boolean(),
    lastLaunchVersion: z.string().nullable(),
    lastActiveDay: z.string().nullable(),
    notice: z.object({
      presentedAt: z.number().nullable(),
      acknowledgedAt: z.number().nullable(),
    }),
    outbox: z
      .array(z.object({ seq: z.number().int(), time: z.number(), event: z.unknown() }))
      .max(MAX_OUTBOX_EVENTS),
  })
  .strict();

export const initialState = (installationId: string): ProductAnalyticsState => ({
  installationId,
  installationReported: false,
  lastLaunchVersion: null,
  lastActiveDay: null,
  notice: { presentedAt: null, acknowledgedAt: null },
  outbox: [],
});

/** Throws on a malformed document; a stored event no longer in the catalog is simply dropped. */
export const decodeState = (raw: string): ProductAnalyticsState => {
  const stored = StoredState.parse(JSON.parse(raw));
  return {
    installationId: stored.installationId,
    installationReported: stored.installationReported,
    lastLaunchVersion: stored.lastLaunchVersion,
    lastActiveDay: stored.lastActiveDay,
    notice: stored.notice,
    outbox: stored.outbox.flatMap((entry) => {
      const event = decodeProductEvent(entry.event);
      return event ? [{ seq: entry.seq, time: entry.time, event }] : [];
    }),
  };
};

export const encodeState = (state: ProductAnalyticsState): string =>
  `${JSON.stringify({ schemaVersion: 1, ...state })}\n`;

const nextSeq = (state: ProductAnalyticsState): number =>
  state.outbox.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1;

export const enqueue = (
  state: ProductAnalyticsState,
  event: ProductEvent,
  time: number,
): ProductAnalyticsState => ({
  ...state,
  outbox: [...state.outbox, { seq: nextSeq(state), time, event }].slice(-MAX_OUTBOX_EVENTS),
});

/** One launch of this build, plus the installation event the first time analytics are active. */
export const admitLaunch = (
  state: ProductAnalyticsState,
  input: {
    readonly appVersion: string;
    readonly profile: "new" | "existing";
    readonly time: number;
  },
): ProductAnalyticsState => {
  const first = !state.installationReported;
  const installed = first
    ? enqueue(
        state,
        { name: "installation_created", properties: { profile: input.profile } },
        input.time,
      )
    : state;
  const launch = first
    ? "first"
    : state.lastLaunchVersion === input.appVersion
      ? "returning"
      : "updated";
  return {
    ...enqueue(installed, { name: "app_launched", properties: { launch } }, input.time),
    installationReported: true,
    lastLaunchVersion: input.appVersion,
  };
};

export const deliveryOpen = (state: ProductAnalyticsState, now: number): boolean => {
  const { presentedAt, acknowledgedAt } = state.notice;
  if (acknowledgedAt !== null) return true;
  return presentedAt !== null && now - presentedAt >= NOTICE_GRACE_MS;
};

export const retryDelayMs = (consecutiveFailures: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));

export const dropExpired = (state: ProductAnalyticsState, now: number): ProductAnalyticsState => {
  const outbox = state.outbox.filter((entry) => now - entry.time <= MAX_EVENT_AGE_MS);
  return outbox.length === state.outbox.length ? state : { ...state, outbox };
};

/** Delivery batches small sessions by age and busy ones by size, and never retries early. */
export const dueBatch = (
  state: ProductAnalyticsState,
  input: { readonly now: number; readonly retryAt: number | null; readonly force?: boolean },
): readonly OutboxEntry[] => {
  if (!deliveryOpen(state, input.now)) return [];
  const oldest = state.outbox[0];
  if (oldest === undefined) return [];
  if (input.force === true) return state.outbox.slice(0, MAX_BATCH_EVENTS);
  if (input.retryAt !== null && input.now < input.retryAt) return [];
  const due =
    state.outbox.length >= FLUSH_AFTER_EVENTS || input.now - oldest.time >= FLUSH_AFTER_AGE_MS;
  return due ? state.outbox.slice(0, MAX_BATCH_EVENTS) : [];
};

export const removeDelivered = (
  state: ProductAnalyticsState,
  delivered: readonly OutboxEntry[],
): ProductAnalyticsState => {
  const seqs = new Set(delivered.map((entry) => entry.seq));
  return { ...state, outbox: state.outbox.filter((entry) => !seqs.has(entry.seq)) };
};

/** A rejected batch can never succeed; only transient failures stay in the outbox. */
export const shouldRetryStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export interface AnalyticsContext {
  readonly appVersion: string;
  readonly channel: "stable" | "nightly" | "development";
  readonly tier: "production" | "development";
  readonly os: string;
  readonly arch: string;
  readonly locale: string;
}

export const contextFields = (context: AnalyticsContext): Record<string, string> => ({
  app_version: context.appVersion,
  channel: context.channel,
  os: context.os,
  arch: context.arch,
  locale: context.locale,
});

export interface StatsigRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Statsig metadata values are strings; the catalog bounds what each one can hold. */
const stringifyProperties = (properties: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  ) as Record<string, string>;

/**
 * `userID` is the random installation identity, never an account: Statsig's active-user and
 * retention metrics are computed from it.
 */
export const statsigRequest = (input: {
  readonly installationId: string;
  readonly context: AnalyticsContext;
  readonly entries: readonly OutboxEntry[];
  readonly now: number;
}): StatsigRequest => ({
  headers: {
    "content-type": "application/json",
    "statsig-api-key": STATSIG_CLIENT_KEY,
    "statsig-client-time": String(input.now),
  },
  body: JSON.stringify({
    user: {
      userID: input.installationId,
      appVersion: input.context.appVersion,
      locale: input.context.locale,
      statsigEnvironment: { tier: input.context.tier },
      custom: {
        channel: input.context.channel,
        os: input.context.os,
        arch: input.context.arch,
      },
    },
    events: input.entries.map(({ time, event }) => ({
      eventName: event.name,
      time,
      ...(event.value === undefined ? {} : { value: event.value }),
      metadata: stringifyProperties(event.properties),
    })),
    statsigMetadata: { sdkType: "nodex-desktop", sdkVersion: input.context.appVersion },
  }),
});
