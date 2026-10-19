import type { AgentRootActivity } from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity as SessionActivity,
  AgentRuntimeSessionActivityChange,
  AgentRuntimeSessionActivitySnapshot,
} from "../../shared/agent-runtime-api";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";

/**
 * Live execution facts for Runtime-bound Sessions, keyed by product Session.
 * The Runtime owns the facts; Core never stores them; windows read one shared projection.
 */
export interface AgentRuntimeSessionActivityShape {
  /** Bounded snapshot of non-idle Sessions. Reading never starts an idle Runtime. */
  readonly read: Effect.Effect<AgentRuntimeSessionActivitySnapshot>;
  readonly connection: Effect.Effect<AgentRuntimeConnectionState>;
  /** Changes published after subscription; a `reset` requires a fresh snapshot. */
  readonly activityChanges: Stream.Stream<AgentRuntimeSessionActivityChange>;
  readonly connectionChanges: Stream.Stream<AgentRuntimeConnectionState>;
}

export class AgentRuntimeSessionActivity extends Context.Service<
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityShape
>()("nodex/main/agent-runtime/AgentRuntimeSessionActivity") {}

/** A Main graph without an execution owner reports no live work. */
export const inactive: AgentRuntimeSessionActivityShape = {
  read: Effect.succeed({ sequence: 0, items: [], complete: true }),
  connection: Effect.succeed({ status: "idle" }),
  activityChanges: Stream.never,
  connectionChanges: Stream.never,
};

/** One observed change of a bound root within a single process generation. */
export interface AgentRuntimeActivityTransition {
  readonly connection: AgentRuntimeProcessConnection;
  readonly sessionId: string;
  readonly rootThreadId: string;
  readonly before: SessionActivity | null;
  readonly after: SessionActivity | null;
  /** The foreground Run that ended in this change and its terminal status when observed. */
  readonly endedRun: { readonly runId: string; readonly status: string | null } | null;
}

/** Root Thread to product Session; roots without a Session binding are absent. */
export type AgentRuntimeSessionResolver = (
  runtimeId: string,
  rootThreadIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, string>, unknown>;

export interface AgentRuntimeSessionActivityOptions {
  readonly resolveSessions: AgentRuntimeSessionResolver;
  /** Runtime page size for full reads. */
  readonly pageSize?: number;
  /** Most Sessions returned by one renderer snapshot. */
  readonly snapshotLimit?: number;
  /** Notifications arriving within this window share one point read. */
  readonly coalesce?: Duration.Input;
  /** Buffered activity changes before a slow observer must reload its snapshot. */
  readonly changeCapacity?: number;
}

const POINT_READ_LIMIT = 100;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

interface State {
  readonly sequence: number;
  readonly generation: string | null;
  readonly sessions: ReadonlyMap<string, SessionActivity>;
  /** Tracked non-idle roots; null marks a root whose Session binding is not known yet. */
  readonly roots: ReadonlyMap<string, string | null>;
}

const sameActivity = (left: SessionActivity | null, right: SessionActivity | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.status === right.status &&
    left.activeRunId === right.activeRunId &&
    left.pendingRequestCount === right.pendingRequestCount &&
    left.activeTaskCount === right.activeTaskCount &&
    left.resumesAutomatically === right.resumesAutomatically &&
    left.providerInstanceId === right.providerInstanceId &&
    left.model === right.model &&
    left.updatedAt === right.updatedAt);

const toSessionActivity = (sessionId: string, root: AgentRootActivity): SessionActivity => ({
  sessionId,
  threadId: root.rootThreadId,
  status: root.status,
  activeRunId: root.activeRunId,
  pendingRequestCount: root.pendingRequestCount,
  activeTaskCount: root.activeTaskCount,
  resumesAutomatically: root.resumesAutomatically,
  providerInstanceId: root.providerInstanceId,
  model: root.model,
  updatedAt: root.updatedAt,
});

const chunks = <A>(values: readonly A[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );

/** Resolves roots through Core's indexed `(runtime, root Thread)` binding lookup. */
export const coreSessionResolver = Effect.gen(function* () {
  const core = yield* CoreModules;
  const resolve: AgentRuntimeSessionResolver = (runtimeId, rootThreadIds) =>
    Effect.forEach(
      rootThreadIds,
      (rootThreadId) =>
        core.workspace
          .read({
            kind: "agent_runtime_session_binding_by_execution",
            runtime_id: runtimeId,
            runtime_thread_id: rootThreadId,
          })
          .pipe(
            Effect.provideService(CoreApplicationAgent, null),
            Effect.map((snapshot) =>
              snapshot.value.kind === "agent_runtime_session_binding" && snapshot.value.binding
                ? ([rootThreadId, snapshot.value.binding.session_id] as const)
                : null,
            ),
          ),
      { concurrency: 8 },
    ).pipe(
      Effect.map(
        (entries) =>
          new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null)),
      ),
    );
  return resolve;
});

/**
 * Main's Session activity projection. Each process generation reads `execution.activity` once,
 * follows activity notifications from one execution observation, point-reads changed roots and
 * maps them to Sessions. Memory holds only non-idle roots; delivery gaps and generation changes
 * publish `reset`. Slow observers recover from bounded-channel overflow with the same snapshot.
 */
export const make = Effect.fn("AgentRuntimeSessionActivity.make")(function* (
  options: AgentRuntimeSessionActivityOptions,
) {
  const pageSize = options.pageSize ?? 200;
  const snapshotLimit = options.snapshotLimit ?? 500;
  const coalesce = options.coalesce ?? Duration.millis(25);
  const lock = yield* Semaphore.make(1);
  const state = yield* Ref.make<State>({
    sequence: 0,
    generation: null,
    sessions: new Map(),
    roots: new Map(),
  });
  const changes = yield* PubSub.sliding<AgentRuntimeSessionActivityChange>(
    options.changeCapacity ?? MAIN_OBSERVATION_EVENT_CAPACITY,
  );
  const transitions = yield* PubSub.sliding<AgentRuntimeActivityTransition>(1_024);
  yield* Effect.addFinalizer(() =>
    PubSub.shutdown(changes).pipe(Effect.andThen(PubSub.shutdown(transitions))),
  );

  const read = Ref.get(state).pipe(
    Effect.map((current): AgentRuntimeSessionActivitySnapshot => {
      const items = [...current.sessions.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      return {
        sequence: current.sequence,
        items: items.slice(0, snapshotLimit),
        complete: items.length <= snapshotLimit,
      };
    }),
  );

  /** Replaces the projection wholesale; renderers re-read after the `reset`. */
  const replace = (
    generation: string | null,
    next: Pick<State, "sessions" | "roots">,
    announce: ((before: State) => Effect.Effect<void>) | null,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const before = yield* Ref.get(state);
        const sequence = before.sequence + 1;
        yield* Ref.set(state, { sequence, generation, ...next });
        yield* PubSub.publish(changes, { type: "reset", sequence });
        if (announce) yield* announce(before);
      }),
    );

  const attach = Effect.fn("AgentRuntimeSessionActivity.attach")(function* (
    connection: AgentRuntimeProcessConnection,
  ) {
    const { runtimeId, runtimeGeneration: generation } = connection.identity;
    const deliveries = yield* connection.subscribeExecutionNotifications;
    let subscriptionId = (yield* connection.request("execution.observe", {})).subscriptionId;
    yield* Effect.addFinalizer(() =>
      connection
        .request("events.unobserve", { subscriptionId })
        .pipe(Effect.timeout("2 seconds"), Effect.ignore),
    );
    yield* Effect.addFinalizer(() =>
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          current.generation === generation
            ? replace(null, { sessions: new Map(), roots: new Map() }, null)
            : Effect.void,
        ),
      ),
    );
    /** Terminal statuses of currently active foreground Runs, consumed by their transition. */
    const terminalRuns = new Map<string, string>();
    let floor = 0;

    const resolveBindings = (rootThreadIds: readonly string[]) =>
      rootThreadIds.length === 0
        ? Effect.succeed(new Map<string, string>())
        : options.resolveSessions(runtimeId, rootThreadIds);

    const announce =
      (
        roots: Iterable<string>,
        afterOf: (current: State, rootThreadId: string) => SessionActivity | null,
        sessionOf: (rootThreadId: string) => string | null,
      ) =>
      (before: State) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          for (const rootThreadId of roots) {
            const sessionId = sessionOf(rootThreadId);
            if (!sessionId) continue;
            const previous = before.sessions.get(sessionId) ?? null;
            const next = afterOf(current, rootThreadId);
            if (sameActivity(previous, next)) continue;
            const endedRunId =
              previous?.activeRunId && previous.activeRunId !== next?.activeRunId
                ? previous.activeRunId
                : null;
            const status = endedRunId ? (terminalRuns.get(endedRunId) ?? null) : null;
            if (endedRunId) terminalRuns.delete(endedRunId);
            yield* PubSub.publish(transitions, {
              connection,
              sessionId,
              rootThreadId,
              before: previous,
              after: next,
              endedRun: endedRunId ? { runId: endedRunId, status } : null,
            });
          }
        });

    /** Full bounded read; within a generation its differences are announced as transitions. */
    const reload = (announceChanges: boolean) =>
      Effect.gen(function* () {
        const items: AgentRootActivity[] = [];
        let cursor: string | undefined;
        let snapshotSequence = 0;
        do {
          const page = yield* connection.request("execution.activity", {
            limit: pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          });
          items.push(...page.items);
          snapshotSequence = Math.max(snapshotSequence, page.snapshotSequence);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        const known = (yield* Ref.get(state)).roots;
        const unknown = items
          .map((item) => item.rootThreadId)
          .filter((rootThreadId) => !known.get(rootThreadId));
        const resolved = new Map<string, string>();
        for (const chunk of chunks(unknown, POINT_READ_LIMIT))
          for (const [rootThreadId, sessionId] of yield* resolveBindings(chunk))
            resolved.set(rootThreadId, sessionId);
        const sessionOf = (rootThreadId: string) =>
          known.get(rootThreadId) ?? resolved.get(rootThreadId) ?? null;
        const roots = new Map(
          items.map((item) => [item.rootThreadId, sessionOf(item.rootThreadId)]),
        );
        const sessions = new Map<string, SessionActivity>();
        for (const item of items) {
          const sessionId = roots.get(item.rootThreadId);
          if (sessionId) sessions.set(sessionId, toSessionActivity(sessionId, item));
        }
        floor = snapshotSequence;
        const previous = yield* Ref.get(state);
        const touched = new Set([...previous.roots.keys(), ...roots.keys()]);
        yield* replace(
          generation,
          { sessions, roots },
          announceChanges && previous.generation === generation
            ? announce(
                touched,
                (current, rootThreadId) => {
                  const sessionId = current.roots.get(rootThreadId);
                  return sessionId ? (current.sessions.get(sessionId) ?? null) : null;
                },
                (rootThreadId) =>
                  roots.get(rootThreadId) ?? previous.roots.get(rootThreadId) ?? null,
              )
            : null,
        );
      });

    /** Point-reads changed roots; absent roots became idle. */
    const refresh = (rootThreadIds: readonly string[]) =>
      Effect.forEach(
        chunks(rootThreadIds, POINT_READ_LIMIT),
        (chunk) =>
          Effect.gen(function* () {
            const page = yield* connection.request("execution.activity", {
              rootThreadIds: chunk,
            });
            const present = new Map(page.items.map((item) => [item.rootThreadId, item]));
            const known = (yield* Ref.get(state)).roots;
            const resolved = yield* resolveBindings(
              chunk.filter((rootThreadId) => present.has(rootThreadId) && !known.get(rootThreadId)),
            );
            const sessionOf = (rootThreadId: string) =>
              known.get(rootThreadId) ?? resolved.get(rootThreadId) ?? null;
            yield* lock.withPermit(
              Effect.gen(function* () {
                const before = yield* Ref.get(state);
                if (before.generation !== generation) return;
                const sessions = new Map(before.sessions);
                const roots = new Map(before.roots);
                const published: AgentRuntimeSessionActivityChange[] = [];
                let sequence = before.sequence;
                for (const rootThreadId of chunk) {
                  const item = present.get(rootThreadId);
                  const sessionId = sessionOf(rootThreadId);
                  if (item) roots.set(rootThreadId, sessionId);
                  else roots.delete(rootThreadId);
                  if (!sessionId) continue;
                  const previous = sessions.get(sessionId) ?? null;
                  const next = item ? toSessionActivity(sessionId, item) : null;
                  if (sameActivity(previous, next)) continue;
                  sequence += 1;
                  if (next) {
                    sessions.set(sessionId, next);
                    published.push({ type: "upsert", sequence, activity: next });
                  } else {
                    sessions.delete(sessionId);
                    published.push({ type: "remove", sequence, sessionId });
                  }
                }
                yield* Ref.set(state, { sequence, generation, sessions, roots });
                yield* PubSub.publishAll(changes, published);
                yield* announce(
                  chunk,
                  (current, rootThreadId) => {
                    const sessionId = current.roots.get(rootThreadId);
                    return sessionId ? (current.sessions.get(sessionId) ?? null) : null;
                  },
                  (rootThreadId) => sessionOf(rootThreadId),
                )(before);
              }),
            );
          }),
        { discard: true },
      );

    let lastDelivery: number | null = null;
    const accept = (batch: readonly AgentRuntimeProcessDelivery[]) =>
      Effect.gen(function* () {
        let stale = false;
        let resubscribe = false;
        const changed = new Set<string>();
        const active = new Set(
          [...(yield* Ref.get(state)).sessions.values()].flatMap((activity) =>
            activity.activeRunId ? [activity.activeRunId] : [],
          ),
        );
        for (const { delivery, notification } of batch) {
          if (lastDelivery !== null && delivery !== lastDelivery + 1) stale = true;
          lastDelivery = delivery;
          if (notification.type === "activity") {
            if (notification.sequence > floor) changed.add(notification.rootThreadId);
          } else if (
            notification.type === "execution.lifecycle" &&
            notification.subscriptionId === subscriptionId &&
            notification.runId &&
            notification.runStatus &&
            TERMINAL_RUN_STATUSES.has(notification.runStatus) &&
            active.has(notification.runId)
          ) {
            terminalRuns.set(notification.runId, notification.runStatus);
          } else if (
            notification.type === "event.error" &&
            notification.subscriptionId === subscriptionId
          ) {
            resubscribe = true;
          }
        }
        if (resubscribe) {
          subscriptionId = (yield* connection.request("execution.observe", {})).subscriptionId;
          stale = true;
        }
        if (stale) return yield* reload(true);
        if (changed.size > 0) yield* refresh([...changed]);
      });

    yield* reload(false).pipe(
      Effect.andThen(
        deliveries.pipe(Stream.groupedWithin(128, coalesce), Stream.runForEach(accept)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Session activity observation stopped for this execution process").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
      Effect.forkScoped,
    );
  });

  // Each subscriber owns its cursor. Sliding never blocks execution; a missed change becomes
  // a reset rather than a partial patch that could leave a Session permanently stale.
  const activityChanges = Stream.unwrap(
    Effect.gen(function* () {
      const [subscription, baseline] = yield* lock.withPermit(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return [subscription, (yield* Ref.get(state)).sequence] as const;
        }),
      );
      return Stream.fromSubscription(subscription).pipe(
        Stream.mapAccum(
          () => baseline,
          (sequence, change): readonly [number, readonly AgentRuntimeSessionActivityChange[]] => {
            if (change.sequence <= sequence) return [sequence, []];
            if (change.sequence !== sequence + 1)
              return [change.sequence, [{ type: "reset", sequence: change.sequence }]];
            return [change.sequence, [change]];
          },
        ),
      );
    }),
  );

  return {
    /** Bounded snapshot of non-idle Sessions; reading never starts a process. */
    read,
    activityChanges,
    /** Observes one process generation for the lifetime of the caller's Scope; never starts one. */
    attach,
    /** Bound root changes within one generation, for unread and notification policy. */
    transitions: Stream.fromPubSub(transitions),
  };
});
