import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface ThreadCreationRelease {
  readonly hostId: string;
  readonly generation: number;
  readonly threadId: string;
}

export interface ThreadCreationRuntimeService {
  /**
   * Fences one app-server operation until its returned Thread has been materialized locally, then
   * releases any notification that won the response race without delaying the committed caller.
   */
  readonly materialize: <A, E, R>(
    hostId: string,
    generation: number,
    operation: Effect.Effect<A, E, R>,
    threadId: (value: A) => string | null,
  ) => Effect.Effect<A, E, R>;
  /** Claims an arriving `thread/started` for an open materialization on the same Endpoint. */
  readonly defer: (hostId: string, generation: number, threadId: string) => boolean;
  /** Internal protocol-consumer stream. */
  readonly releases: Stream.Stream<ThreadCreationRelease>;
  /** Fails if release admission can no longer preserve canonical notification delivery. */
  readonly termination: Effect.Effect<never, ThreadCreationOverflow>;
  readonly clear: (threadId: string) => void;
}

export class ThreadCreationRuntime extends Context.Service<
  ThreadCreationRuntime,
  ThreadCreationRuntimeService
>()("nodex/main/codex-application/ThreadCreationRuntime") {}

export class ThreadCreationOverflow extends Schema.TaggedError<ThreadCreationOverflow>()(
  "ThreadCreationOverflow",
  {
    capacity: Schema.Int,
    hostId: Schema.String,
    generation: Schema.Int,
    threadId: Schema.String,
  },
) {}

/**
 * Application-scoped owner of physical Thread creation. Each admitted operation receives a local
 * launch intent and continues in this runtime's Scope if its renderer waiter disappears. The
 * app-server does not echo a client launch id in `thread/started`, so notifications that beat the
 * response are held in a host-generation cohort; the response's exact Thread id is the commit
 * correlation. Release is one-way: a local commit never waits on the protocol actor.
 */
export const makeWithCapacity = (
  capacity: number,
): Effect.Effect<ThreadCreationRuntimeService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const normalizedCapacity = Math.max(1, Math.floor(capacity));
    const releases = yield* Queue.dropping<ThreadCreationRelease>(normalizedCapacity);
    const termination = yield* Deferred.make<never, ThreadCreationOverflow>();
    const ownerScope = yield* Effect.scope;
    let nextLaunchId = 0;
    const intents = new Map<number, string>();
    const cohorts = new Map<
      string,
      {
        readonly hostId: string;
        readonly generation: number;
        readonly launchIds: Set<number>;
        readonly deferredThreadIds: Set<string>;
        readonly readyThreadIds: Set<string>;
      }
    >();

    yield* Effect.addFinalizer(() => Queue.shutdown(releases).pipe(Effect.asVoid));

    const normalizeHostId = (hostId: string): string => hostId.trim();
    const cohortKey = (hostId: string, generation: number): string =>
      `${hostId}\u0000${generation}`;
    const cohortState = (hostId: string, generation: number) => {
      const key = cohortKey(hostId, generation);
      const existing = cohorts.get(key);
      if (existing) return existing;
      const created = {
        hostId,
        generation,
        launchIds: new Set<number>(),
        deferredThreadIds: new Set<string>(),
        readyThreadIds: new Set<string>(),
      };
      cohorts.set(key, created);
      return created;
    };

    const offerRelease = (
      hostId: string,
      generation: number,
      threadId: string,
    ): Effect.Effect<void> =>
      Queue.offer(releases, { hostId, generation, threadId }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Deferred.fail(
                termination,
                new ThreadCreationOverflow({
                  capacity: normalizedCapacity,
                  hostId,
                  generation,
                  threadId,
                }),
              ).pipe(Effect.asVoid),
        ),
      );

    const release = (hostId: string, generation: number, threadId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const normalizedHostId = normalizeHostId(hostId);
        const normalizedThreadId = threadId.trim();
        if (!normalizedHostId || !normalizedThreadId) return Effect.void;
        const state = cohortState(normalizedHostId, generation);
        state.readyThreadIds.add(normalizedThreadId);
        if (!state.deferredThreadIds.delete(normalizedThreadId)) return Effect.void;
        return offerRelease(normalizedHostId, generation, normalizedThreadId);
      });

    const begin = (hostId: string, generation: number): number => {
      nextLaunchId += 1;
      const key = cohortKey(hostId, generation);
      intents.set(nextLaunchId, key);
      cohortState(hostId, generation).launchIds.add(nextLaunchId);
      return nextLaunchId;
    };

    const end = (launchId: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        const key = intents.get(launchId);
        if (!key) return Effect.void;
        intents.delete(launchId);
        const state = cohorts.get(key);
        if (!state) return Effect.void;
        state.launchIds.delete(launchId);
        if (state.launchIds.size > 0) return Effect.void;
        const pending = [...state.deferredThreadIds];
        cohorts.delete(key);
        return Effect.forEach(
          pending,
          (threadId) => offerRelease(state.hostId, state.generation, threadId),
          { discard: true },
        );
      });

    return ThreadCreationRuntime.of({
      materialize: (hostId, generation, operation, threadId) =>
        Effect.uninterruptibleMask((restore) => {
          const normalizedHostId = normalizeHostId(hostId);
          if (!normalizedHostId) return restore(operation);
          const launchId = begin(normalizedHostId, generation);
          const physical = operation.pipe(
            Effect.tap((value) => {
              const identified = threadId(value);
              return identified === null
                ? Effect.void
                : release(normalizedHostId, generation, identified);
            }),
            Effect.ensuring(end(launchId)),
          );
          return physical.pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.flatMap((fiber) => restore(Fiber.join(fiber))),
          );
        }),
      defer: (hostId, generation, threadId) => {
        const normalizedHostId = normalizeHostId(hostId);
        const normalizedThreadId = threadId.trim();
        const state = cohorts.get(cohortKey(normalizedHostId, generation));
        if (
          !normalizedHostId ||
          !normalizedThreadId ||
          !state ||
          state.launchIds.size === 0 ||
          state.readyThreadIds.has(normalizedThreadId)
        ) {
          return false;
        }
        state.deferredThreadIds.add(normalizedThreadId);
        return true;
      },
      releases: Stream.fromQueue(releases),
      termination: Deferred.await(termination),
      clear: (threadId) => {
        const normalized = threadId.trim();
        if (!normalized) return;
        for (const state of cohorts.values()) {
          state.deferredThreadIds.delete(normalized);
          state.readyThreadIds.delete(normalized);
        }
      },
    });
  });

export const make = makeWithCapacity(1_024);
