import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { getLogger } from "../logging/logger";
import { syncEffectDirectory } from "../platform/node/filesystem-durability";
import type {
  ProductAnalyticsActivity,
  ProductAnalyticsNotice,
} from "../../shared/product-analytics/activity";
import {
  decodeRendererProductEvent,
  type ProductEvent,
} from "../../shared/product-analytics/catalog";
import { analyticsDay } from "../../shared/product-analytics/names";
import type { TelemetrySettings } from "../../shared/types";
import {
  admitLaunch,
  contextFields,
  decodeState,
  dropExpired,
  dueBatch,
  encodeState,
  enqueue,
  initialState,
  removeDelivered,
  retryDelayMs,
  shouldRetryStatus,
  statsigRequest,
  type AnalyticsContext,
  type OutboxEntry,
  type ProductAnalyticsState,
  type StatsigRequest,
} from "./product-analytics-state";
import { productEventFromRuntime } from "./runtime-events";

const TICK = Duration.seconds(15);
const SHUTDOWN_DELIVERY = Duration.millis(1_500);
const MAX_SENT_HISTORY = 100;
const logger = getLogger({ subsystem: "product-analytics" });

export interface ProductAnalyticsShape {
  /** Trusted Main callers; the type system is the catalog. */
  readonly record: (event: ProductEvent) => Effect.Effect<void>;
  readonly recordFromRenderer: (value: unknown) => Effect.Effect<void>;
  readonly recordFromRuntime: (
    name: string,
    properties: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly notice: Effect.Effect<ProductAnalyticsNotice>;
  readonly noticePresented: Effect.Effect<void>;
  readonly noticeAcknowledged: Effect.Effect<void>;
  readonly activity: Effect.Effect<ProductAnalyticsActivity>;
}

export const inertProductAnalytics: ProductAnalyticsShape = {
  record: () => Effect.void,
  recordFromRenderer: () => Effect.void,
  recordFromRuntime: () => Effect.void,
  notice: Effect.succeed({ present: false }),
  noticePresented: Effect.void,
  noticeAcknowledged: Effect.void,
  activity: Effect.succeed({
    active: false,
    installationId: null,
    context: {},
    pending: [],
    sent: [],
  }),
};

/** The single exit for product analytics. Consumers record; only this Module talks to a network. */
export class ProductAnalytics extends Context.Reference<ProductAnalyticsShape>(
  "nodex/main/product-analytics/ProductAnalytics",
  { defaultValue: () => inertProductAnalytics },
) {}

export interface ProductAnalyticsPorts {
  readonly statePath: string;
  readonly context: AnalyticsContext;
  readonly telemetry: TelemetrySettings;
  readonly telemetryChanges: Stream.Stream<TelemetrySettings>;
  /** Whether any remote signal is on, so the notice describes something that is happening. */
  readonly noticeApplies: Effect.Effect<boolean>;
  readonly profileKind: Effect.Effect<"new" | "existing">;
  readonly windowFocused: Effect.Effect<boolean>;
  readonly send: (request: StatsigRequest) => Effect.Effect<number, unknown>;
}

export const make = Effect.fn("ProductAnalytics.make")(function* (ports: ProductAnalyticsPorts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const directory = path.dirname(ports.statePath);

  const persist = (state: ProductAnalyticsState) =>
    Effect.gen(function* () {
      const unique = yield* newId;
      const temporaryPath = path.join(
        directory,
        `.${path.basename(ports.statePath)}.${unique}.tmp`,
      );
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(encodeState(state)));
              yield* file.sync;
            }),
          ),
        ),
        Effect.andThen(fs.rename(temporaryPath, ports.statePath)),
        Effect.andThen(syncEffectDirectory(fs, directory)),
        Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
      );
    });

  const load = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const raw = yield* fs.readFileString(ports.statePath).pipe(Effect.option);
    if (Option.isNone(raw)) return initialState(yield* newId);
    return yield* Effect.try(() => decodeState(raw.value)).pipe(
      Effect.catch(() =>
        fs
          .rename(ports.statePath, `${ports.statePath}.corrupt-${now}`)
          .pipe(Effect.ignore, Effect.andThen(newId), Effect.map(initialState)),
      ),
    );
  });

  const state = yield* Ref.make(yield* load);
  const active = yield* Ref.make(ports.telemetry.active);
  const sent = yield* Ref.make<readonly OutboxEntry[]>([]);
  const failures = yield* Ref.make(0);
  const retryAt = yield* Ref.make<number | null>(null);
  const unsaved = yield* Ref.make(false);
  const lock = yield* Semaphore.make(1);

  /**
   * Memory is authoritative. A save the system refuses, such as Windows declining to replace a
   * document another handle has open, is repeated by the next change, delivery tick, or quit.
   */
  const save = (next: ProductAnalyticsState) =>
    persist(next).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Ref.set(unsaved, false),
        // Local persistence failing must never reach the feature that recorded an event.
        onFailure: (cause) =>
          Ref.getAndSet(unsaved, true).pipe(
            Effect.flatMap((repeated) =>
              repeated
                ? Effect.void
                : Effect.sync(() =>
                    logger.warn("Product analytics state was not saved", { cause }),
                  ),
            ),
          ),
      }),
    );

  const mutate = (change: (current: ProductAnalyticsState, now: number) => ProductAnalyticsState) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(state);
        const next = change(current, now);
        if (next === current && !(yield* Ref.get(unsaved))) return;
        yield* Ref.set(state, next);
        yield* save(next);
      }),
    );

  const record = (event: ProductEvent) =>
    Effect.gen(function* () {
      if (!(yield* Ref.get(active))) return;
      yield* mutate((current, now) => enqueue(current, event, now));
    });

  const admitActivation = Effect.gen(function* () {
    const profile = yield* ports.profileKind;
    yield* mutate((current, now) =>
      admitLaunch(current, { appVersion: ports.context.appVersion, profile, time: now }),
    );
  });

  /** A person counts as active on a UTC day only once a window of theirs has had focus. */
  const observeFocus = Effect.gen(function* () {
    if (!(yield* Ref.get(active)) || !(yield* ports.windowFocused)) return;
    yield* mutate((current, now) => {
      const day = analyticsDay(now);
      if (current.lastActiveDay === day) return current;
      return {
        ...enqueue(current, { name: "app_active", properties: {} }, now),
        lastActiveDay: day,
      };
    });
  });

  /** Turning analytics off withdraws everything that has not left the machine. */
  const withdraw = Effect.gen(function* () {
    yield* Ref.set(sent, []);
    yield* mutate((current) =>
      current.outbox.length === 0 ? current : { ...current, outbox: [] },
    );
  });

  const deliver = (options: { readonly force: boolean }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* mutate((current) => dropExpired(current, now));
      if (!(yield* Ref.get(active))) return;
      const batch = dueBatch(yield* Ref.get(state), {
        now,
        retryAt: yield* Ref.get(retryAt),
        force: options.force,
      });
      if (batch.length === 0) return;
      const { installationId } = yield* Ref.get(state);
      const outcome = yield* ports
        .send(statsigRequest({ installationId, context: ports.context, entries: batch, now }))
        .pipe(Effect.result);
      if (outcome._tag === "Failure" || shouldRetryStatus(outcome.success)) {
        const consecutive = (yield* Ref.get(failures)) + 1;
        yield* Ref.set(failures, consecutive);
        yield* Ref.set(retryAt, now + retryDelayMs(consecutive));
        return;
      }
      yield* Ref.set(failures, 0);
      yield* Ref.set(retryAt, null);
      // A batch the service rejected can never succeed, so it also leaves the outbox.
      if (outcome.success >= 400)
        logger.warn("Product analytics batch was rejected", { status: outcome.success });
      else yield* Ref.update(sent, (history) => [...history, ...batch].slice(-MAX_SENT_HISTORY));
      yield* mutate((current) => removeDelivered(current, batch));
    });

  // Analytics turned off while the app was closed also withdraws what an earlier launch left.
  yield* ports.telemetry.active ? admitActivation : withdraw;

  yield* ports.telemetryChanges.pipe(
    Stream.runForEach((settings) =>
      Effect.gen(function* () {
        const wasActive = yield* Ref.getAndSet(active, settings.active);
        if (!settings.active) return yield* withdraw;
        if (!wasActive) yield* admitActivation;
      }),
    ),
    Effect.forkScoped,
  );

  // One tick's defect must not end delivery for the rest of the process.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(TICK);
    yield* Effect.all([observeFocus, deliver({ force: false })], { discard: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => logger.warn("Product analytics delivery failed", { cause })),
      ),
    );
  }).pipe(Effect.forever, Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    deliver({ force: true }).pipe(Effect.timeoutOption(SHUTDOWN_DELIVERY), Effect.ignore),
  );

  return {
    record,
    recordFromRenderer: (value) => {
      const event = decodeRendererProductEvent(value);
      return event ? record(event) : Effect.void;
    },
    recordFromRuntime: (name, properties) => {
      const event = productEventFromRuntime(name, properties);
      return event === null ? Effect.void : record(event);
    },
    notice: Effect.gen(function* () {
      const { notice } = yield* Ref.get(state);
      return { present: notice.acknowledgedAt === null && (yield* ports.noticeApplies) };
    }),
    noticePresented: mutate((current, now) =>
      current.notice.presentedAt !== null
        ? current
        : { ...current, notice: { ...current.notice, presentedAt: now } },
    ),
    noticeAcknowledged: mutate((current, now) =>
      current.notice.acknowledgedAt !== null
        ? current
        : {
            ...current,
            notice: { presentedAt: current.notice.presentedAt ?? now, acknowledgedAt: now },
          },
    ),
    activity: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const toEntry = ({ time, event }: OutboxEntry) => ({ time, event });
      return {
        active: yield* Ref.get(active),
        installationId: current.installationId,
        context: contextFields(ports.context),
        pending: current.outbox.map(toEntry),
        sent: (yield* Ref.get(sent)).map(toEntry),
      };
    }),
  } satisfies ProductAnalyticsShape;
});
