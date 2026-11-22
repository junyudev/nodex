import { claudeAgent } from "../../shared/agents/claude";
import { isManagedRuntimeInstanceId } from "../../shared/managed-runtime-instances";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivityChange,
  SubscriptionUsageSnapshot,
} from "../../shared/agent-runtime-api";
import {
  meteredSubscriptionProviders,
  SUBSCRIPTION_USAGE_PROVIDERS,
  subscriptionUsageProvider,
  subscriptionUsageReadAt,
  subscriptionMeter,
  subscriptionMeters,
} from "../../shared/subscription-usage";
import { AgentRuntimeApplicationError, agentRuntimeFailureReason } from "./AgentRuntimeApplication";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type MeterPreferences = Readonly<Record<string, boolean>>;
type DeclaredAgents = Readonly<Record<string, readonly string[]>>;

const meterEnabled = (meters: MeterPreferences, key: string) => meters[key] !== false;

const deferredMeters = subscriptionMeters.filter(
  ({ deferredReadingMs }) => deferredReadingMs !== undefined,
);

const anyMeterEnabled = (meters: MeterPreferences, providers: Providers | null = null) =>
  SUBSCRIPTION_USAGE_PROVIDERS.some((key) => meterEnabled(meters, key)) ||
  (providers ?? []).some((provider) => {
    const key = subscriptionUsageProvider(provider);
    return key !== null && meterEnabled(meters, key);
  });

const reportedOutsideSettings = (provider: Providers[number]) => {
  const key = subscriptionUsageProvider(provider);
  return key !== null && !subscriptionMeter(key)?.trackedBySettings;
};

/** Subscription usage is read again once the reading is this old. */
export const SUBSCRIPTION_USAGE_POLL_INTERVAL = Duration.minutes(5);
/** An explicit refresh this soon after the last one reuses it, so passing over a meter reads once. */
export const SUBSCRIPTION_USAGE_REFRESH_FLOOR = Duration.minutes(1);

/**
 * When subscription usage is next read on its own: once the oldest reading is an interval old, and no
 * sooner than an interval after the last attempt, so a read that keeps failing never spins.
 */
export function nextSubscriptionUsageReadAt(input: {
  readonly readings: readonly (number | null)[];
  readonly lastAttemptAt: number | null;
  readonly intervalMs: number;
}): number {
  const oldest = Math.min(...input.readings.map((readAt) => readAt ?? -Infinity));
  return (
    Math.max(input.lastAttemptAt ?? -Infinity, input.readings.length > 0 ? oldest : -Infinity) +
    input.intervalMs
  );
}

export class AgentRuntimeSubscriptionUsage extends Context.Service<
  AgentRuntimeSubscriptionUsage,
  {
    readonly snapshot: SubscriptionRef.SubscriptionRef<SubscriptionUsageSnapshot>;
    /** Reads usage again now through the Agents' own checks, unless it was just read. */
    readonly refresh: Effect.Effect<SubscriptionUsageSnapshot>;
    /**
     * Takes over what Nodex knows about subscription Agents again, such as after a settings change;
     * never starts execution.
     */
    readonly reread: Effect.Effect<void>;
    readonly logoutClaude: (
      instanceIds: readonly string[],
    ) => Effect.Effect<SubscriptionUsageSnapshot, AgentRuntimeApplicationError>;
  }
>()("nodex/main/agent-runtime/AgentRuntimeSubscriptionUsage") {}

export interface AgentRuntimeSubscriptionUsageOptions {
  /** The enabled subscription-capable Agents declared now. */
  readonly declared: Effect.Effect<DeclaredAgents, unknown>;
  /** What Nodex knows about its Agents without starting execution; null when nothing is current. */
  readonly known: Effect.Effect<Providers | null, unknown>;
  /** Checks the named Agents again from scratch, starting execution when it is stopped. */
  readonly refresh: (instanceIds: readonly string[]) => Effect.Effect<Providers, unknown>;
  /** The same check only while execution already runs; null when it is stopped. */
  readonly refreshWhileRunning: (
    instanceIds: readonly string[],
  ) => Effect.Effect<Providers | null, unknown>;
  readonly logout: (instanceIds: readonly string[]) => Effect.Effect<Providers, unknown>;
  /** Whole catalogs execution served to anything else, such as a model menu. */
  readonly served: Stream.Stream<Providers>;
  readonly connectionChanges: Stream.Stream<AgentRuntimeConnectionState>;
  readonly activityChanges: Stream.Stream<AgentRuntimeSessionActivityChange>;
  readonly meters: MeterPreferences;
  readonly meterChanges?: Stream.Stream<MeterPreferences>;
  readonly pollInterval?: Duration.Input;
  readonly refreshFloor?: Duration.Input;
}

/**
 * The person's own subscription accounts. Instances Nodex declares itself, for credits or an API key, pay
 * per request and have no subscription limits to show.
 */
const subscriptionRows = (providers: Providers): Providers =>
  providers.filter(
    (provider) =>
      subscriptionUsageProvider(provider) !== null &&
      provider.source !== "nodex" &&
      !isManagedRuntimeInstanceId(provider.instanceId),
  );

/**
 * The subscription Agents a catalog describes, each as of its latest check. A kept catalog can be older
 * than a from-scratch read that was never kept, so an Agent checked more recently stays as read.
 */
export function adoptSubscriptionRows(current: Providers | null, catalog: Providers): Providers {
  const checkedAt = (row: Providers[number]) => Date.parse(row.checkedAt);
  const kept = new Map(current?.map((row) => [row.instanceId, row]));
  return subscriptionRows(catalog).map((row) => {
    const previous = kept.get(row.instanceId);
    return previous && checkedAt(previous) > checkedAt(row) ? previous : row;
  });
}

/**
 * Main's one owner of runtime subscription usage, so every window shows the same reading. It reads
 * only through the Agents' own checks. A shown meter is read again every interval while
 * execution runs anyway; only someone asking, by opening a card, starts it to read. Launching,
 * saving settings and every execution event merely take over what Nodex already knows.
 */
export const make = Effect.fn("AgentRuntimeSubscriptionUsage.make")(function* (
  options: AgentRuntimeSubscriptionUsageOptions,
) {
  const intervalMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.pollInterval ?? SUBSCRIPTION_USAGE_POLL_INTERVAL),
  );
  const floorMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.refreshFloor ?? SUBSCRIPTION_USAGE_REFRESH_FLOOR),
  );
  // The first read of its own waits an interval after launch, like every later one.
  const startedAt = yield* Clock.currentTimeMillis;
  const snapshot = yield* SubscriptionRef.make<SubscriptionUsageSnapshot>({
    status: "loading",
    providers: null,
    reason: null,
  });
  /** Paces reading again: every from-scratch attempt, even one skipped while stopped. */
  const lastAttemptAt = yield* Ref.make(startedAt);
  /** Floors explicit refreshes: from-scratch reads that actually ran. */
  const lastFreshReadAt = yield* Ref.make<number | null>(null);
  const reads = yield* Semaphore.make(1);
  const meters = yield* Ref.make(options.meters);
  const reconcileAt = yield* Ref.make<number | null>(null);
  const deferredDeclarations = yield* Ref.make<DeclaredAgents>({});
  // Each wakes its loop to reconsider; sliding so a burst of requests asks once.
  const schedule = yield* Queue.sliding<void>(1);
  const rereads = yield* Queue.sliding<void>(1);
  const scope = yield* Effect.scope;

  const publish = (next: SubscriptionUsageSnapshot) =>
    SubscriptionRef.set(snapshot, next).pipe(Effect.andThen(Queue.offer(schedule, undefined)));
  const publishFailure = (cause: unknown) =>
    SubscriptionRef.get(snapshot).pipe(
      Effect.flatMap((current) =>
        publish({
          status: "unavailable",
          providers: current.providers,
          reason: agentRuntimeFailureReason(cause),
        }),
      ),
    );

  /**
   * Takes over what Nodex knows. With nothing current it keeps what it read before, minus Agents
   * no longer declared, so a removed profile's meter goes away while execution is stopped.
   */
  const readKnown = reads.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(snapshot);
      if (!anyMeterEnabled(yield* Ref.get(meters), current.providers)) return;
      const result = yield* Effect.result(
        options.declared.pipe(
          Effect.tap((declared) => Ref.set(deferredDeclarations, declared)),
          Effect.flatMap((declared) => {
            const instanceIds = Object.values(declared).flat();
            // Self-reporting Agents first join through a catalog that execution served.
            if (!instanceIds.length && !current.providers?.some(reportedOutsideSettings))
              return Effect.succeed([instanceIds, [] as Providers] as const);
            return options.known.pipe(Effect.map((known) => [instanceIds, known] as const));
          }),
        ),
      );
      if (Result.isFailure(result)) return yield* publishFailure(result.failure);
      const [instanceIds, known] = result.success;
      const declared = new Set(instanceIds);
      if (known !== null)
        return yield* publish({
          status: "ready",
          providers: adoptSubscriptionRows(current.providers, known).filter(
            (row) => declared.has(row.instanceId) || reportedOutsideSettings(row),
          ),
          reason: null,
        });
      yield* publish({
        status: current.status === "loading" ? "ready" : current.status,
        providers:
          current.providers?.filter(
            (row) => declared.has(row.instanceId) || reportedOutsideSettings(row),
          ) ?? current.providers,
        reason: current.reason,
      });
    }),
  );

  /**
   * Reads the declared Agents with enabled meters again from scratch; `start` lets it start execution to do
   * so. A failed read keeps what was read, and one skipped while stopped changes nothing.
   */
  const readNow = (start: boolean) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(snapshot);
      if (!anyMeterEnabled(yield* Ref.get(meters), current.providers)) return;
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastAttemptAt, now);
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const declared = yield* options.declared;
          const enabled = yield* Ref.get(meters);
          const request = Object.keys(declared)
            .sort()
            .flatMap((key) => (meterEnabled(enabled, key) ? declared[key] : []));
          const reported = (current.providers ?? []).flatMap((row) => {
            const key = subscriptionUsageProvider(row);
            return key !== null && reportedOutsideSettings(row) && meterEnabled(enabled, key)
              ? [row.instanceId]
              : [];
          });
          const instanceIds = [...new Set([...request, ...reported])];
          const providers =
            instanceIds.length === 0
              ? []
              : yield* start
                  ? options.refresh(instanceIds)
                  : options.refreshWhileRunning(instanceIds);
          return providers === null ? null : { declared, instanceIds, providers };
        }),
      );
      if (Result.isFailure(result)) return yield* publishFailure(result.failure);
      if (result.success === null) return;
      const { declared, instanceIds, providers } = result.success;
      yield* Ref.set(deferredDeclarations, declared);
      // Some Agents publish usage after their health check returns.
      const delay = Math.min(
        ...deferredMeters.flatMap(({ preference, deferredReadingMs }) =>
          declared[preference]?.some((id) => instanceIds.includes(id)) &&
          deferredReadingMs !== undefined
            ? [deferredReadingMs]
            : [],
        ),
      );
      if (Number.isFinite(delay))
        yield* Ref.set(reconcileAt, (yield* Clock.currentTimeMillis) + delay);
      const all = new Set(Object.values(declared).flat());
      const refreshed = new Set(instanceIds);
      yield* Ref.set(lastFreshReadAt, now);
      yield* publish({
        status: "ready",
        providers: [
          ...(current.providers ?? []).filter(
            (row) =>
              (all.has(row.instanceId) || reportedOutsideSettings(row)) &&
              !refreshed.has(row.instanceId),
          ),
          ...subscriptionRows(providers).filter((row) => refreshed.has(row.instanceId)),
        ],
        reason: null,
      });
    });

  /**
   * Someone asked to see current usage. Callers that arrive while one read runs share it, and a
   * read that ran moments ago, on its own or for an earlier caller, stands in.
   */
  const askedInFlight = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const readAsked = reads.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(snapshot);
      const last = yield* Ref.get(lastFreshReadAt);
      const now = yield* Clock.currentTimeMillis;
      if (current.status !== "unavailable" && last !== null && now - last < floorMs) return;
      yield* readNow(true);
    }),
  );
  const refresh = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const candidate = yield* Deferred.make<void>();
      const claimed = yield* Ref.modify(
        askedInFlight,
        (
          current,
        ): readonly [
          { readonly owner: boolean; readonly done: Deferred.Deferred<void> },
          Deferred.Deferred<void> | null,
        ] => {
          if (current) return [{ owner: false, done: current }, current];
          return [{ owner: true, done: candidate }, candidate];
        },
      );
      // Claim and fork together so cancellation cannot leave an ownerless shared read.
      // The read belongs to this Module's scope and stays interruptible on shutdown.
      if (claimed.owner)
        yield* readAsked.pipe(
          Effect.ensuring(
            Ref.set(askedInFlight, null).pipe(
              Effect.andThen(Deferred.succeed(claimed.done, undefined)),
            ),
          ),
          Effect.forkIn(scope, { uninterruptible: false }),
        );
      yield* restore(Deferred.await(claimed.done));
      return yield* SubscriptionRef.get(snapshot);
    }),
  );

  const reread = Queue.offer(rereads, undefined).pipe(Effect.asVoid);
  yield* Effect.forever(Queue.take(rereads).pipe(Effect.andThen(readKnown))).pipe(
    Effect.forkScoped,
  );

  // While execution runs, a shown meter is kept no older than the interval, and a read that
  // failed with nothing to show is retried at the same pace. Neither starts execution.
  const nextRead = Effect.gen(function* () {
    const enabled = yield* Ref.get(meters);
    const current = yield* SubscriptionRef.get(snapshot);
    if (!anyMeterEnabled(enabled, current.providers)) return null;
    const metered = meteredSubscriptionProviders(current.providers).filter((row) => {
      const provider = subscriptionUsageProvider(row);
      return provider !== null && meterEnabled(enabled, provider);
    });
    if (metered.length > 0)
      return nextSubscriptionUsageReadAt({
        readings: metered.map(subscriptionUsageReadAt),
        lastAttemptAt: yield* Ref.get(lastAttemptAt),
        intervalMs,
      });
    const declarations = yield* Ref.get(deferredDeclarations);
    if (
      (current.status === "unavailable" && current.providers === null) ||
      deferredMeters.some(
        ({ preference }) =>
          meterEnabled(enabled, preference) && (declarations[preference]?.length ?? 0) > 0,
      )
    )
      return (yield* Ref.get(lastAttemptAt)) + intervalMs;
    return null;
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      const refreshAt = yield* nextRead;
      const enabled = yield* Ref.get(meters);
      const pendingReconcile = deferredMeters.some(({ preference }) =>
        meterEnabled(enabled, preference),
      )
        ? yield* Ref.get(reconcileAt)
        : null;
      const at =
        refreshAt === null ? pendingReconcile : Math.min(refreshAt, pendingReconcile ?? refreshAt);
      if (at === null) return yield* Queue.take(schedule);
      const delay = Math.max(0, at - (yield* Clock.currentTimeMillis));
      // Races the due time against a state change that may move it.
      const due = yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(delay)).pipe(Effect.as(true)),
        Queue.take(schedule).pipe(Effect.as(false)),
      );
      if (!due) return;
      if (pendingReconcile === at) {
        const reconcile = yield* Ref.modify(reconcileAt, (current) =>
          current === pendingReconcile ? [true, null] : [false, current],
        );
        if (reconcile) return yield* readKnown;
      }
      yield* reads.withPermits(1)(
        Effect.gen(function* () {
          const reconsidered = yield* nextRead;
          if (reconsidered === null || reconsidered > (yield* Clock.currentTimeMillis)) return;
          yield* readNow(false);
        }),
      );
    }),
  ).pipe(Effect.forkScoped);

  // A whole catalog served to any other reader describes the same Agents just as currently.
  yield* options.served.pipe(
    Stream.runForEach((providers) =>
      SubscriptionRef.get(snapshot).pipe(
        Effect.flatMap((current) =>
          publish({
            status: "ready",
            providers: adoptSubscriptionRows(current.providers, providers),
            reason: null,
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // Execution reports usage while Agents reply and checks Agents when it starts.
  let ready = false;
  yield* options.connectionChanges.pipe(
    Stream.runForEach((state) => {
      const becameReady = state.status === "ready" && !ready;
      ready = state.status === "ready";
      return becameReady ? reread : Effect.void;
    }),
    Effect.forkScoped,
  );
  const running = new Map<string, string>();
  yield* options.activityChanges.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        if (change.type === "reset") {
          running.clear();
          return yield* reread;
        }
        const sessionId = change.type === "upsert" ? change.activity.sessionId : change.sessionId;
        if (change.type === "upsert" && change.activity.status === "running") {
          running.set(sessionId, change.activity.providerInstanceId);
          return;
        }
        const instanceId = running.get(sessionId);
        if (instanceId === undefined) return;
        running.delete(sessionId);
        const { providers } = yield* SubscriptionRef.get(snapshot);
        if (providers?.some((provider) => provider.instanceId === instanceId)) yield* reread;
      }),
    ),
    Effect.forkScoped,
  );

  if (options.meterChanges)
    yield* options.meterChanges.pipe(
      Stream.runForEach((enabled) =>
        Effect.gen(function* () {
          const previous = yield* Ref.getAndSet(meters, enabled);
          const changed = [...new Set([...Object.keys(previous), ...Object.keys(enabled)])].filter(
            (provider) => meterEnabled(previous, provider) !== meterEnabled(enabled, provider),
          );
          if (changed.length === 0) return;
          yield* Queue.offer(schedule, undefined);
          if (changed.some((provider) => meterEnabled(enabled, provider)))
            yield* reads.withPermits(1)(readNow(true)).pipe(Effect.forkIn(scope));
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  yield* reread;

  const logoutClaude = (instanceIds: readonly string[]) =>
    reads
      .withPermits(1)(
        Effect.gen(function* () {
          const declared = new Set((yield* options.declared)[claudeAgent.usageMeter.preference]);
          if (instanceIds.some((id) => !declared.has(id)))
            return yield* Effect.fail(new Error("Choose a configured Claude Agent to sign out."));
          const signedOut = yield* options.logout(instanceIds);
          const replaced = new Map(subscriptionRows(signedOut).map((row) => [row.instanceId, row]));
          const current = yield* SubscriptionRef.get(snapshot);
          yield* publish({
            ...current,
            providers: (current.providers ?? []).map((row) => replaced.get(row.instanceId) ?? row),
          });
          return yield* SubscriptionRef.get(snapshot);
        }),
      )
      .pipe(
        // A sign-out that stopped partway still changed some Agents; read them all again.
        Effect.tapError(() => reread),
        Effect.mapError(
          (cause) =>
            new AgentRuntimeApplicationError({
              operation: "subscription-usage-logout-claude",
              message: agentRuntimeFailureReason(cause),
              cause,
            }),
        ),
      );

  return AgentRuntimeSubscriptionUsage.of({ snapshot, refresh, reread, logoutClaude });
});
