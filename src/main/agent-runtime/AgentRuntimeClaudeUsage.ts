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
  ClaudeUsageSnapshot,
} from "../../shared/agent-runtime-api";
import { claudeUsageReadAt, meteredClaudeProviders } from "../../shared/claude-usage";
import { AgentRuntimeApplicationError, agentRuntimeFailureReason } from "./AgentRuntimeApplication";

type Providers = AgentRuntimeOperations["providers.read"]["output"];

/** Claude usage is read again once the reading is this old. */
export const CLAUDE_USAGE_POLL_INTERVAL = Duration.minutes(5);
/** An explicit refresh this soon after the last one reuses it, so passing over a meter reads once. */
export const CLAUDE_USAGE_REFRESH_FLOOR = Duration.minutes(1);

/**
 * When Claude usage is next read on its own: once the oldest reading is an interval old, and no
 * sooner than an interval after the last attempt, so a read that keeps failing never spins.
 */
export function nextClaudeUsageReadAt(input: {
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

export class AgentRuntimeClaudeUsage extends Context.Service<
  AgentRuntimeClaudeUsage,
  {
    readonly snapshot: SubscriptionRef.SubscriptionRef<ClaudeUsageSnapshot>;
    /** Reads usage again now through the Claude Agents' own checks, unless it was just read. */
    readonly refresh: Effect.Effect<ClaudeUsageSnapshot>;
    /**
     * Takes over what Nodex knows about the Claude Agents again, such as after a settings change;
     * never starts execution.
     */
    readonly reread: Effect.Effect<void>;
    readonly logout: (
      instanceIds: readonly string[],
    ) => Effect.Effect<ClaudeUsageSnapshot, AgentRuntimeApplicationError>;
  }
>()("nodex/main/agent-runtime/AgentRuntimeClaudeUsage") {}

export interface AgentRuntimeClaudeUsageOptions {
  /** The enabled Claude Agents declared now. */
  readonly declared: Effect.Effect<readonly string[], unknown>;
  /** What Nodex knows about its Agents without starting execution; null when nothing is current. */
  readonly known: Effect.Effect<Providers | null, unknown>;
  /** Checks the named Agents again from scratch, starting execution when it is stopped. */
  readonly refresh: (instanceIds: readonly string[]) => Effect.Effect<Providers, unknown>;
  readonly logout: (instanceIds: readonly string[]) => Effect.Effect<Providers, unknown>;
  /** Whole catalogs execution served to anything else, such as a model menu. */
  readonly served: Stream.Stream<Providers>;
  readonly connectionChanges: Stream.Stream<AgentRuntimeConnectionState>;
  readonly activityChanges: Stream.Stream<AgentRuntimeSessionActivityChange>;
  readonly pollInterval?: Duration.Input;
  readonly refreshFloor?: Duration.Input;
}

const claudeRows = (providers: Providers): Providers =>
  providers.filter((provider) => provider.driver === "claudeAgent");

/**
 * The Claude Agents a catalog describes, each as of its latest check. A kept catalog can be older
 * than a from-scratch read that was never kept, so an Agent checked more recently stays as read.
 */
export function adoptClaudeRows(current: Providers | null, catalog: Providers): Providers {
  const checkedAt = (row: Providers[number]) => Date.parse(row.checkedAt);
  const kept = new Map(current?.map((row) => [row.instanceId, row]));
  return claudeRows(catalog).map((row) => {
    const previous = kept.get(row.instanceId);
    return previous && checkedAt(previous) > checkedAt(row) ? previous : row;
  });
}

/**
 * Main's one owner of Claude subscription usage, so every window shows the same reading. It reads
 * only through the Claude Agents' own checks. Only keeping a shown meter current and an explicit
 * refresh may start execution; launching, saving settings and every execution event merely take
 * over what Nodex already knows.
 */
export const make = Effect.fn("AgentRuntimeClaudeUsage.make")(function* (
  options: AgentRuntimeClaudeUsageOptions,
) {
  const intervalMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.pollInterval ?? CLAUDE_USAGE_POLL_INTERVAL),
  );
  const floorMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.refreshFloor ?? CLAUDE_USAGE_REFRESH_FLOOR),
  );
  // A launch stays quiet: the first read of its own waits an interval, like every later one.
  const startedAt = yield* Clock.currentTimeMillis;
  const snapshot = yield* SubscriptionRef.make<ClaudeUsageSnapshot>({
    status: "loading",
    providers: null,
    reason: null,
  });
  const lastAttemptAt = yield* Ref.make(startedAt);
  const lastFreshReadAt = yield* Ref.make<number | null>(null);
  const reads = yield* Semaphore.make(1);
  const freshInFlight = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  // Each wakes its loop to reconsider; sliding so a burst of requests asks once.
  const schedule = yield* Queue.sliding<void>(1);
  const rereads = yield* Queue.sliding<void>(1);
  const scope = yield* Effect.scope;

  const publish = (next: ClaudeUsageSnapshot) =>
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
      yield* Ref.set(lastAttemptAt, yield* Clock.currentTimeMillis);
      const result = yield* Effect.result(
        options.declared.pipe(
          Effect.flatMap((instanceIds) =>
            instanceIds.length === 0
              ? Effect.succeed([instanceIds, [] as Providers] as const)
              : options.known.pipe(Effect.map((known) => [instanceIds, known] as const)),
          ),
        ),
      );
      if (Result.isFailure(result)) return yield* publishFailure(result.failure);
      const [instanceIds, known] = result.success;
      const declared = new Set(instanceIds);
      const current = yield* SubscriptionRef.get(snapshot);
      if (known !== null)
        return yield* publish({
          status: "ready",
          providers: adoptClaudeRows(current.providers, known).filter((row) =>
            declared.has(row.instanceId),
          ),
          reason: null,
        });
      yield* publish({
        status: current.status === "loading" ? "ready" : current.status,
        providers:
          current.providers?.filter((row) => declared.has(row.instanceId)) ?? current.providers,
        reason: current.reason,
      });
    }),
  );

  /** Reads the declared Claude Agents again from scratch. A failed read keeps what was read. */
  const readNow = reads.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastAttemptAt, now);
      yield* Ref.set(lastFreshReadAt, now);
      const result = yield* Effect.result(
        options.declared.pipe(
          Effect.flatMap((instanceIds) =>
            instanceIds.length === 0
              ? Effect.succeed([] as Providers)
              : options.refresh(instanceIds),
          ),
        ),
      );
      if (Result.isFailure(result)) return yield* publishFailure(result.failure);
      yield* publish({ status: "ready", providers: claudeRows(result.success), reason: null });
    }),
  );

  /** A fresh read; callers that arrive while one runs share it. */
  const readFresh = Effect.gen(function* () {
    const claimed = yield* Ref.modify(
      freshInFlight,
      (
        current,
      ): readonly [
        { readonly owner: boolean; readonly done: Deferred.Deferred<void> },
        Deferred.Deferred<void> | null,
      ] => {
        if (current) return [{ owner: false, done: current }, current];
        const done = Deferred.makeUnsafe<void>();
        return [{ owner: true, done }, done];
      },
    );
    // Forked into this owner's scope so an interrupted caller cannot cancel a shared read.
    if (claimed.owner)
      yield* readNow.pipe(
        Effect.ensuring(
          Ref.set(freshInFlight, null).pipe(
            Effect.andThen(Deferred.succeed(claimed.done, undefined)),
          ),
        ),
        Effect.forkIn(scope),
      );
    yield* Deferred.await(claimed.done);
  });

  const refresh = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(snapshot);
    const last = yield* Ref.get(lastFreshReadAt);
    const now = yield* Clock.currentTimeMillis;
    if (current.status !== "unavailable" && last !== null && now - last < floorMs) return current;
    yield* readFresh;
    return yield* SubscriptionRef.get(snapshot);
  });

  const reread = Queue.offer(rereads, undefined).pipe(Effect.asVoid);
  yield* Effect.forever(Queue.take(rereads).pipe(Effect.andThen(readKnown))).pipe(
    Effect.forkScoped,
  );

  // A shown meter is kept no older than the interval. When nothing could be read at all, the
  // same pace retries until something answers. Nothing else here starts execution.
  const nextRead = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(snapshot);
    const metered = meteredClaudeProviders(current.providers);
    if (metered.length > 0)
      return nextClaudeUsageReadAt({
        readings: metered.map(claudeUsageReadAt),
        lastAttemptAt: (yield* Ref.get(lastFreshReadAt)) ?? startedAt,
        intervalMs,
      });
    if (current.status === "unavailable" && current.providers === null)
      return (yield* Ref.get(lastAttemptAt)) + intervalMs;
    return null;
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      const at = yield* nextRead;
      if (at === null) return yield* Queue.take(schedule);
      const delay = Math.max(0, at - (yield* Clock.currentTimeMillis));
      // Races the due time against a state change that may move it.
      const due = yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(delay)).pipe(Effect.as(true)),
        Queue.take(schedule).pipe(Effect.as(false)),
      );
      if (due) yield* readFresh;
    }),
  ).pipe(Effect.forkScoped);

  // A whole catalog served to any other reader describes the same Agents just as currently.
  yield* options.served.pipe(
    Stream.runForEach((providers) =>
      SubscriptionRef.get(snapshot).pipe(
        Effect.flatMap((current) =>
          publish({
            status: "ready",
            providers: adoptClaudeRows(current.providers, providers),
            reason: null,
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // Execution reports usage while Claude replies and checks Agents when it starts.
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

  yield* reread;

  const logout = (instanceIds: readonly string[]) =>
    reads
      .withPermits(1)(
        Effect.gen(function* () {
          const signedOut = yield* options.logout(instanceIds);
          const replaced = new Map(claudeRows(signedOut).map((row) => [row.instanceId, row]));
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
              operation: "claude-usage-logout",
              message: agentRuntimeFailureReason(cause),
              cause,
            }),
        ),
      );

  return AgentRuntimeClaudeUsage.of({ snapshot, refresh, reread, logout });
});
