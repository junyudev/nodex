import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  ProviderKeyUsage as Usage,
  ProviderKeyUsageSnapshot,
} from "../../shared/provider-key-usage";
import {
  providerKeyConnectionIdOfInstanceId,
  providerKeyRuntimeInstanceId,
  type ProviderKeyConnection,
} from "../../shared/provider-keys";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import {
  ApplicationSettings,
  type ProviderKeySettingsChange,
} from "../settings/ApplicationSettings";

const REFRESH_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = 15 * 60_000;
const SETTLE_DELAY = "3 seconds";

export type ProviderKeyReading = Pick<Usage, "balance" | "windows">;
type ReadUsage = (
  key: Redacted.Redacted,
) => Effect.Effect<ProviderKeyReading | null, "read-failed">;

/** An absent reader is unsupported. An absent reading means this key has no reportable usage. */
export type ProviderKeyUsageReader = (connection: ProviderKeyConnection) => ReadUsage | undefined;

export class ProviderKeyUsage extends Context.Service<
  ProviderKeyUsage,
  {
    readonly read: Effect.Effect<ProviderKeyUsageSnapshot>;
    readonly changes: Stream.Stream<ProviderKeyUsageSnapshot>;
    readonly refresh: (connectionId?: string) => Effect.Effect<ProviderKeyUsageSnapshot>;
  }
>()("nodex/main/provider-keys/ProviderKeyUsage") {}

interface ConnectionUsage {
  readonly connection: ProviderKeyConnection;
  readonly read: ReadUsage;
  readonly scope: Scope.Closeable;
  readonly settled: Queue.Queue<void>;
  reading: Usage | null;
  lastStartedAt: number | null;
  inFlight: Fiber.Fiber<void> | null;
}

export const make = Effect.fn("ProviderKeyUsage.make")(function* (reader: ProviderKeyUsageReader) {
  const settings = yield* ApplicationSettings;
  const activity = yield* AgentRuntimeSessionActivity;
  const scope = yield* Scope.Scope;
  const snapshot = yield* SubscriptionRef.make<ProviderKeyUsageSnapshot>({ connections: [] });
  const lock = yield* Semaphore.make(1);
  const entries = new Map<string, ConnectionUsage>();

  const publish = SubscriptionRef.updateSome(snapshot, (previous) => {
    const connections = [...entries.values()].flatMap(({ reading }) => (reading ? [reading] : []));
    if (
      previous.connections.length === connections.length &&
      previous.connections.every((entry, index) => entry === connections[index])
    )
      return Option.none();
    return Option.some({ connections });
  });

  const readUsage = (entry: ConnectionUsage) =>
    Effect.gen(function* () {
      const connectionId = entry.connection.id;
      const reading = yield* settings.providerKeySecret(connectionId).pipe(
        Effect.flatMap(entry.read),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* lock.withPermit(
        Effect.gen(function* () {
          // A new key or a disabled connection retires the old request, including any late answer.
          if (entries.get(connectionId) !== entry) return;
          entry.inFlight = null;
          if (reading === undefined) {
            if (entry.reading?.readFailed) return;
            entry.reading = {
              connectionId,
              balance: null,
              windows: [],
              observedAt: null,
              ...entry.reading,
              readFailed: true,
            };
          } else {
            entry.reading = reading && {
              ...reading,
              connectionId,
              observedAt: now,
              readFailed: false,
            };
          }
          yield* publish;
        }),
      );
    });

  const requestRead = (entry: ConnectionUsage, minAgeMs: number) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (entries.get(entry.connection.id) !== entry) return null;
          if (entry.inFlight) return entry.inFlight;
          const now = yield* Clock.currentTimeMillis;
          if (entry.lastStartedAt !== null && now - entry.lastStartedAt < minAgeMs) return null;
          entry.lastStartedAt = now;
          entry.inFlight = yield* readUsage(entry).pipe(
            Effect.interruptible,
            Effect.forkIn(entry.scope),
          );
          return entry.inFlight;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(
        Effect.flatMap((fiber) => (fiber ? Fiber.await(fiber) : Effect.void)),
        Effect.asVoid,
      );

  const start = (entry: ConnectionUsage) =>
    Effect.gen(function* () {
      // Each connection polls only after a full interval without a read, from any source.
      yield* Effect.gen(function* () {
        yield* requestRead(entry, POLL_INTERVAL_MS);
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, (entry.lastStartedAt ?? now) + POLL_INTERVAL_MS - now));
      }).pipe(Effect.forever, Effect.interruptible, Effect.forkIn(entry.scope));

      yield* Stream.fromQueue(entry.settled).pipe(
        Stream.debounce(SETTLE_DELAY),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const dueAt = yield* Clock.currentTimeMillis;
            yield* requestRead(entry, 0);
            // If this joined an older in-flight read, follow it with a new observation.
            if ((entry.lastStartedAt ?? -Infinity) < dueAt) yield* requestRead(entry, 0);
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(entry.scope),
      );
    });

  const reconcile = ({ settings: { connections }, savedKeyId }: ProviderKeySettingsChange) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const retired = [...entries.values()].filter(
            ({ connection }) =>
              connection.id === savedKeyId ||
              !connections.some(
                (next) =>
                  next.id === connection.id &&
                  next.enabled &&
                  next.preset === connection.preset &&
                  next.endpoint === connection.endpoint,
              ),
          );
          for (const { connection } of retired) entries.delete(connection.id);
          for (const connection of connections) {
            if (!connection.enabled || entries.has(connection.id)) continue;
            const read = reader(connection);
            if (!read) continue;
            const entry: ConnectionUsage = {
              connection,
              read,
              scope: yield* Scope.fork(scope),
              settled: yield* Queue.sliding<void>(1),
              reading: null,
              lastStartedAt: null,
              inFlight: null,
            };
            entries.set(connection.id, entry);
            yield* start(entry);
          }
          if (retired.length > 0) yield* publish;
          return retired;
        }),
      )
      .pipe(
        Effect.flatMap((retired) =>
          Effect.forEach(retired, (entry) => Scope.close(entry.scope, Exit.void), {
            discard: true,
          }),
        ),
        Effect.uninterruptible,
      );

  yield* settings.providerKeySettingsChanges.pipe(
    Stream.runForEach(reconcile),
    Effect.forkScoped({ startImmediately: true }),
  );

  const queueSettled = (instanceId: string) =>
    Effect.gen(function* () {
      const connectionId = providerKeyConnectionIdOfInstanceId(instanceId);
      if (!connectionId) return;
      const entry = entries.get(connectionId);
      if (entry && providerKeyRuntimeInstanceId(entry.connection) === instanceId)
        yield* Queue.offer(entry.settled, undefined);
    });

  const running = new Map<string, string>();
  yield* activity.activityChanges.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        if (change.type === "reset") {
          const { items } = yield* activity.read;
          const previous = [...running];
          running.clear();
          for (const item of items) {
            if (item.status === "running") running.set(item.sessionId, item.providerInstanceId);
          }
          yield* Effect.forEach(
            previous,
            ([id, instanceId]) =>
              running.get(id) === instanceId ? Effect.void : queueSettled(instanceId),
            { discard: true },
          );
          return;
        }
        if (change.type === "upsert" && change.activity.status === "running") {
          running.set(change.activity.sessionId, change.activity.providerInstanceId);
          return;
        }
        const sessionId = change.type === "remove" ? change.sessionId : change.activity.sessionId;
        const instanceId = running.get(sessionId);
        if (!instanceId) return;
        running.delete(sessionId);
        yield* queueSettled(instanceId);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const read = SubscriptionRef.get(snapshot);
  const refresh = (connectionId?: string) =>
    Effect.gen(function* () {
      const selected = [...entries.values()].filter(
        ({ connection }) => connectionId === undefined || connection.id === connectionId,
      );
      yield* Effect.forEach(selected, (entry) => requestRead(entry, REFRESH_INTERVAL_MS), {
        concurrency: "unbounded",
        discard: true,
      });
      return yield* read;
    });
  return ProviderKeyUsage.of({ read, changes: SubscriptionRef.changes(snapshot), refresh });
});

export const live = (reader: ProviderKeyUsageReader) =>
  Layer.effect(ProviderKeyUsage, make(reader));
