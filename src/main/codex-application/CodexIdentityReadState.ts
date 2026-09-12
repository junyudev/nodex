import * as Deferred from "effect/Deferred";
import * as Data from "effect/Data";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  ContextualThreadReadStateChange,
  ThreadReadStateContext,
  ThreadReadStateChange,
  ThreadReadStateEvent,
  ThreadReadStateIdentity,
  ThreadReadStateStatus,
} from "../../shared/codex-thread-read-state";
import { threadReadStateIdentityKey } from "../codex/thread-read-state-identity";

export class IdentityReadStateError extends Data.TaggedError("IdentityReadStateError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface IdentityReadStateSession {
  readonly identity: ThreadReadStateIdentity;
  readonly executionHostKeysByHostId: Readonly<Record<string, string>>;
  readonly unreadThreadIdsByHostId: Readonly<Record<string, readonly string[]>>;
  readonly set: (
    change: ThreadReadStateChange,
  ) => Effect.Effect<ThreadReadStateStatus, IdentityReadStateError>;
  readonly clearForLogout: Effect.Effect<ThreadReadStateStatus, IdentityReadStateError>;
  readonly unsubscribe: Effect.Effect<void>;
}

/** Sends an accepted event directly to the session's observation or transport boundary. */
export type IdentityReadStateListener = (event: ThreadReadStateEvent) => Effect.Effect<void>;

export interface IdentityReadStateOptions {
  readonly readIdentity: Effect.Effect<ThreadReadStateIdentity | null, IdentityReadStateError>;
  readonly hostKeys: Effect.Effect<Record<string, string>, IdentityReadStateError>;
  readonly read: (
    identityKey: string,
  ) => Effect.Effect<Record<string, string[]>, IdentityReadStateError>;
  readonly write: (
    identityKey: string,
    hostKey: string,
    threadId: string,
    unread: boolean,
  ) => Effect.Effect<void, IdentityReadStateError>;
  readonly clear: (identityKey: string) => Effect.Effect<void, IdentityReadStateError>;
  readonly select: (
    identityKey: string | null,
    hosts: Record<string, string>,
  ) => Effect.Effect<void, IdentityReadStateError>;
  readonly project: (change: ThreadReadStateChange) => Effect.Effect<void, IdentityReadStateError>;
  readonly accepted: (
    change: ContextualThreadReadStateChange,
  ) => Effect.Effect<void, IdentityReadStateError>;
}

interface SessionRecord {
  readonly identity: ThreadReadStateIdentity;
  readonly key: string;
  readonly hostKeys: Record<string, string>;
  readonly observed: Record<string, Set<string>>;
  readonly notify: IdentityReadStateListener;
}

export interface IdentityReadStateService {
  readonly hostKeys: IdentityReadStateOptions["hostKeys"];
  readonly captureContext: (hostId: string) => Effect.Effect<{
    context: ThreadReadStateContext;
    isCurrent: Effect.Effect<boolean, IdentityReadStateError>;
  } | null>;
  readonly acceptBroadcast: (
    change: ContextualThreadReadStateChange,
  ) => Effect.Effect<ThreadReadStateStatus, IdentityReadStateError>;
  readonly open: (
    notify: IdentityReadStateListener,
  ) => Effect.Effect<
    | { readonly status: "ready"; readonly session: IdentityReadStateSession }
    | { readonly status: "unavailable" },
    IdentityReadStateError
  >;
  readonly retire: (
    reason: Extract<ThreadReadStateEvent, { type: "retired" }>["reason"],
  ) => Effect.Effect<void>;
  readonly logout: Effect.Effect<void, IdentityReadStateError>;
  readonly refresh: Effect.Effect<void, IdentityReadStateError>;
}

export class CodexIdentityReadState extends Context.Service<
  CodexIdentityReadState,
  IdentityReadStateService
>()("nodex/main/codex-application/CodexIdentityReadState") {}

/** The Profile owns sessions; Core owns identity-scoped unread membership. */
export const makeIdentityReadState = (
  options: IdentityReadStateOptions,
): Effect.Effect<IdentityReadStateService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const owned = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        effect.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
        Fiber.join,
        Fiber.interrupt,
      );
    const lock = yield* Semaphore.make(1);
    const incoming = yield* Semaphore.make(1);
    let identityRefresh: Deferred.Deferred<void> | undefined;
    const sessions = new Set<SessionRecord>();
    let generation = 0;
    let disposed = false;
    let identityKey: string | null = null;
    let loggingOutKey: string | null = null;
    let projectionKey: string | undefined;
    const select = (key: string | null, hosts: Record<string, string>) =>
      Effect.gen(function* () {
        const next = JSON.stringify([key, hosts]);
        if (projectionKey === next) return;
        yield* options.select(key, hosts);
        projectionKey = next;
      });

    const retire = (
      reason: Extract<ThreadReadStateEvent, { type: "retired" }>["reason"],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        generation += 1;
        const retired = [...sessions];
        sessions.clear();
        for (const session of retired) yield* session.notify({ type: "retired", reason });
      });
    const clearIdentity = (key: string) =>
      Effect.gen(function* () {
        loggingOutKey = key;
        yield* options.clear(key);
        yield* select(null, {});
        yield* retire("identity");
      });
    const logout = lock.withPermit(
      Effect.gen(function* () {
        if (identityKey === null) return yield* retire("identity");
        yield* clearIdentity(identityKey);
      }),
    );

    const open = Effect.fn("CodexIdentityReadState.open")(function* (
      notify: IdentityReadStateListener,
    ) {
      const captured = generation;
      const identity = yield* options.readIdentity.pipe(Effect.orElseSucceed(() => null));
      if (identity === null || disposed || generation !== captured)
        return { status: "unavailable" } as const;
      const key = threadReadStateIdentityKey(identity);
      if (key === loggingOutKey) return { status: "unavailable" } as const;
      return yield* lock.withPermit(
        Effect.gen(function* () {
          if (disposed || generation !== captured) return { status: "unavailable" } as const;
          if (identityKey !== null && identityKey !== key) yield* retire("identity");
          identityKey = key;
          const openingGeneration = generation;
          const hostKeys = yield* options.hostKeys;
          if (disposed || generation !== openingGeneration)
            return { status: "unavailable" } as const;
          yield* select(key, hostKeys);
          const unread = yield* options.read(key);
          if (disposed || generation !== openingGeneration)
            return { status: "unavailable" } as const;
          const record: SessionRecord = {
            identity,
            key,
            hostKeys,
            notify,
            observed: Object.fromEntries(
              Object.entries(hostKeys).map(([host, hostKey]) => [
                host,
                new Set(unread[hostKey] ?? []),
              ]),
            ),
          };
          sessions.add(record);
          const unsubscribe = Effect.sync(() => {
            sessions.delete(record);
          });
          const set = (
            change: ThreadReadStateChange,
          ): Effect.Effect<ThreadReadStateStatus, IdentityReadStateError> =>
            owned(
              Effect.gen(function* () {
                for (;;) {
                  const barrier = identityRefresh;
                  if (!barrier) break;
                  yield* Deferred.await(barrier);
                }
                const result = yield* lock.withPermit(
                  Effect.gen(function* () {
                    if (identityRefresh) return null;
                    if (!sessions.has(record)) return { status: "retired" } as const;
                    const hostKey = record.hostKeys[change.hostId];
                    if (hostKey === undefined) return { status: "unavailable" } as const;
                    const currentHosts = yield* options.hostKeys;
                    if (currentHosts[change.hostId] !== hostKey)
                      return { status: "retired" } as const;
                    const current = yield* options.read(record.key);
                    if (
                      (current[hostKey]?.includes(change.threadId) ?? false) ===
                      change.hasUnreadTurn
                    )
                      return { status: "ok" } as const;
                    if (identityRefresh) return null;
                    if (disposed || !sessions.has(record)) return { status: "retired" } as const;
                    yield* options.write(
                      record.key,
                      hostKey,
                      change.threadId,
                      change.hasUnreadTurn,
                    );
                    for (const subscriber of sessions) {
                      if (
                        subscriber.key !== record.key ||
                        subscriber.hostKeys[change.hostId] !== hostKey
                      )
                        continue;
                      if (change.hasUnreadTurn)
                        subscriber.observed[change.hostId]?.add(change.threadId);
                      else subscriber.observed[change.hostId]?.delete(change.threadId);
                      yield* subscriber.notify({
                        type: "changed",
                        origin: subscriber === record ? "self" : "external",
                        ...change,
                      });
                    }
                    yield* options.project(change);
                    yield* options.accepted({
                      ...change,
                      context: { identity: record.identity, executionHostKey: hostKey },
                    });
                    return { status: "ok" } as const;
                  }),
                );
                return result ?? (yield* set(change));
              }),
            );
          return {
            status: "ready",
            session: {
              identity,
              executionHostKeysByHostId: hostKeys,
              unreadThreadIdsByHostId: Object.fromEntries(
                Object.entries(hostKeys).map(([host, hostKey]) => [host, unread[hostKey] ?? []]),
              ),
              set,
              unsubscribe,
              clearForLogout: lock.withPermit(
                Effect.gen(function* () {
                  if (!sessions.has(record)) return { status: "retired" } as const;
                  yield* clearIdentity(record.key);
                  return { status: "ok" } as const;
                }),
              ),
            },
          } as const;
        }),
      );
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        disposed = true;
        yield* retire("disposed");
      }),
    );
    const refresh = owned(
      Effect.gen(function* () {
        const barrier = yield* Deferred.make<void>();
        identityRefresh = barrier;
        const captured = ++generation;
        yield* Effect.gen(function* () {
          const next = yield* options.readIdentity.pipe(Effect.orElseSucceed(() => null));
          yield* lock.withPermit(
            Effect.gen(function* () {
              if (disposed || generation !== captured) return;
              if (next !== null) loggingOutKey = null;
              const nextKey = next === null ? null : threadReadStateIdentityKey(next);
              if (nextKey === null || identityKey !== nextKey) {
                identityKey = nextKey;
                yield* retire(nextKey === null ? "unavailable" : "identity");
              }
              const selectedGeneration = generation;
              const hosts = nextKey === null ? {} : yield* options.hostKeys;
              if (disposed || generation !== selectedGeneration) return;
              yield* select(nextKey, hosts);
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (identityRefresh === barrier) identityRefresh = undefined;
              yield* Deferred.succeed(barrier, undefined);
            }),
          ),
        );
      }),
    );
    const isCurrent = (key: string, captured: number) =>
      !disposed && generation === captured && key !== loggingOutKey;
    const captureContext = (hostId: string) =>
      owned(
        Effect.gen(function* () {
          const captured = generation;
          const hostKey = (yield* options.hostKeys)[hostId];
          if (disposed || hostKey === undefined) return null;
          const identity = yield* options.readIdentity;
          if (identity === null) return null;
          const key = threadReadStateIdentityKey(identity);
          const current = Effect.gen(function* () {
            if (!isCurrent(key, captured)) return false;
            return (yield* options.hostKeys)[hostId] === hostKey && isCurrent(key, captured);
          });
          if (!(yield* current)) return null;
          return { context: { identity, executionHostKey: hostKey }, isCurrent: current };
        }).pipe(Effect.orElseSucceed(() => null)),
      );
    const acceptBroadcast = (change: ContextualThreadReadStateChange) =>
      Effect.suspend(() => {
        const captured = generation;
        return owned(
          incoming.withPermit(
            Effect.gen(function* () {
              if (disposed || captured !== generation) return { status: "retired" } as const;
              const result = yield* options.readIdentity.pipe(
                Effect.map((identity) => ({ identity })),
                Effect.orElseSucceed(() => null),
              );
              if (result === null) return { status: "unavailable" } as const;
              const identity = result.identity;
              if (identity === null) return { status: "retired" } as const;
              const key = threadReadStateIdentityKey(identity);
              return yield* lock.withPermit(
                Effect.gen(function* () {
                  const hosts = yield* options.hostKeys;
                  if (
                    !isCurrent(key, captured) ||
                    key !== threadReadStateIdentityKey(change.context.identity) ||
                    hosts[change.hostId] !== change.context.executionHostKey
                  )
                    return { status: "retired" } as const;
                  const current = yield* options.read(key);
                  if (!isCurrent(key, captured)) return { status: "retired" } as const;
                  const storageChanged =
                    (current[change.context.executionHostKey]?.includes(change.threadId) ??
                      false) !== change.hasUnreadTurn;
                  if (storageChanged)
                    yield* options.write(
                      key,
                      change.context.executionHostKey,
                      change.threadId,
                      change.hasUnreadTurn,
                    );
                  let notified = false;
                  for (const session of sessions) {
                    if (
                      session.key !== key ||
                      session.hostKeys[change.hostId] !== change.context.executionHostKey ||
                      session.observed[change.hostId]?.has(change.threadId) === change.hasUnreadTurn
                    )
                      continue;
                    if (change.hasUnreadTurn) session.observed[change.hostId]?.add(change.threadId);
                    else session.observed[change.hostId]?.delete(change.threadId);
                    notified = true;
                    yield* session.notify({
                      type: "changed",
                      origin: "external",
                      hostId: change.hostId,
                      threadId: change.threadId,
                      hasUnreadTurn: change.hasUnreadTurn,
                    });
                  }
                  if (storageChanged || notified) yield* options.project(change);
                  return { status: "ok" } as const;
                }),
              );
            }),
          ),
        );
      });
    return {
      open: (notify) => owned(open(notify)),
      retire,
      logout: owned(logout),
      refresh,
      hostKeys: options.hostKeys,
      captureContext,
      acceptBroadcast,
    };
  });
