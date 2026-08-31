import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import type {
  BrowserUseIabApi,
  BrowserUseIabAsyncRuntime,
  BrowserUseRoute,
} from "./browser-use-iab-api";
import type {
  BrowserUseNativePipeRequestHandler,
  BrowserUseNativePipeServer,
  BrowserUseNativePipeServerError,
} from "./browser-use-native-pipe-server";

const MAX_DEBUG_EVENTS = 200;
const SESSION_ACTIVITY_PERMITS = Number.MAX_SAFE_INTEGER;

export interface BrowserUseRouteCapture extends BrowserUseRoute {
  readonly disposeAfterSessionActivity?: boolean;
}

export interface BrowserUseTurnLifecycleInput {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface BrowserUseCursorArrivalInput {
  readonly browserConversationId: string;
  readonly browserViewScopeId: string;
  readonly browserTabId: string;
  readonly moveSequence: number;
  readonly ownerWebContentsId: number;
}

export interface BrowserUseSessionRuntimeDebugEvent {
  readonly details?: Record<string, string | number | boolean | null>;
  readonly kind: string;
  readonly sequence: number;
  readonly sessionId: string | null;
  readonly timestampMs: number;
}

export interface BrowserUseSessionRuntimeSnapshot {
  readonly events: readonly BrowserUseSessionRuntimeDebugEvent[];
  readonly sessions: ReadonlyArray<{
    readonly browserConversationId: string;
    readonly browserViewScopeId: string;
    readonly currentTurnId: string | null;
    readonly disposeAfterSessionActivity: boolean;
    readonly ownerWebContentsId: number;
    readonly pipeReady: true;
    readonly sessionId: string;
  }>;
}

export class BrowserUseSessionRuntimeError extends Schema.TaggedError<BrowserUseSessionRuntimeError>()(
  "BrowserUseSessionRuntimeError",
  {
    operation: Schema.String,
    sessionId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface BrowserUseSessionRuntimePlatform {
  readonly createApi: (
    route: BrowserUseRoute,
    asyncRuntime: BrowserUseIabAsyncRuntime,
  ) => Effect.Effect<BrowserUseIabApi, never, Scope.Scope>;
  readonly createServer: (
    handler: BrowserUseNativePipeRequestHandler,
  ) => Effect.Effect<BrowserUseNativePipeServer, BrowserUseNativePipeServerError, Scope.Scope>;
}

export interface BrowserUseSessionRuntime {
  readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  readonly captureRoute: (
    input: BrowserUseRouteCapture,
  ) => Effect.Effect<{ pipePath: string; route: BrowserUseRoute }, BrowserUseSessionRuntimeError>;
  readonly debugSnapshot: Effect.Effect<
    BrowserUseSessionRuntimeSnapshot,
    BrowserUseSessionRuntimeError
  >;
  readonly notifyCursorArrived: (
    input: BrowserUseCursorArrivalInput,
  ) => Effect.Effect<void, BrowserUseSessionRuntimeError>;
  readonly releaseOwner: (
    ownerWebContentsId: number,
  ) => Effect.Effect<void, BrowserUseSessionRuntimeError>;
  readonly releaseSession: (
    sessionId: string,
  ) => Effect.Effect<void, BrowserUseSessionRuntimeError>;
  readonly turnEnded: (
    input: BrowserUseTurnLifecycleInput,
  ) => Effect.Effect<void, BrowserUseSessionRuntimeError>;
  readonly turnStarted: (
    input: BrowserUseTurnLifecycleInput,
  ) => Effect.Effect<void, BrowserUseSessionRuntimeError>;
}

interface SessionKey {
  readonly generation: number;
  readonly initialDisposeAfterSessionActivity: boolean;
  readonly route: BrowserUseRoute;
}

interface RegistryState {
  readonly active: ReadonlyMap<string, SessionKey>;
  readonly events: readonly BrowserUseSessionRuntimeDebugEvent[];
  readonly nextDebugSequence: number;
  readonly nextGeneration: number;
}

interface BrowserUseSessionService {
  readonly hasActiveControl: Effect.Effect<boolean>;
  readonly markDisposeAfterSessionActivity: Effect.Effect<void>;
  readonly notifyCursorArrived: (moveSequence: number) => Effect.Effect<void>;
  readonly pipePath: string;
  readonly route: BrowserUseRoute;
  readonly snapshot: Effect.Effect<{
    readonly currentTurnId: string | null;
    readonly disposeAfterSessionActivity: boolean;
  }>;
  readonly turnEnded: (
    input: BrowserUseTurnLifecycleInput,
  ) => Effect.Effect<boolean, BrowserUseSessionRuntimeError>;
  readonly turnStarted: (input: BrowserUseTurnLifecycleInput) => Effect.Effect<void>;
}

class BrowserUseSession extends Context.Service<BrowserUseSession, BrowserUseSessionService>()(
  "nodex/main/browser-use/BrowserUseSession",
) {}

const runtimeError = (operation: string, sessionId: string, cause: unknown) =>
  new BrowserUseSessionRuntimeError({ operation, sessionId, cause });

const sessionLayer = (
  key: SessionKey,
  platform: BrowserUseSessionRuntimePlatform,
  record: (
    kind: string,
    sessionId: string | null,
    details?: Record<string, string | number | boolean | null>,
  ) => Effect.Effect<void>,
): Layer.Layer<BrowserUseSession, BrowserUseSessionRuntimeError> =>
  Layer.effect(
    BrowserUseSession,
    Effect.gen(function* () {
      const sessionId = key.route.codexSessionId;
      const runPromise = yield* FiberSet.makeRuntimePromise<
        never,
        unknown,
        BrowserUseSessionRuntimeError
      >();
      const waitFor = <A>(
        register: (succeed: (value: A) => void) => () => void,
        timeoutMs: number,
        onTimeout: () => A,
      ): Promise<A> =>
        runPromise(
          Effect.callback<A>((resume) => {
            const release = register((value) => resume(Effect.succeed(value)));
            return Effect.sync(release);
          }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () =>
                Effect.try({
                  try: onTimeout,
                  catch: (cause) => runtimeError("iab-wait-timeout", sessionId, cause),
                }),
            }),
          ),
        );
      const asyncRuntime: BrowserUseIabAsyncRuntime = {
        deadline: (task, timeoutMs, timeoutMessage) =>
          runPromise(
            Effect.tryPromise({
              try: task,
              catch: (cause) => runtimeError("iab-operation", sessionId, cause),
            }).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(timeoutMs),
                orElse: () =>
                  Effect.fail(runtimeError("iab-timeout", sessionId, new Error(timeoutMessage))),
              }),
            ),
          ),
        now: () => runPromise(Clock.currentTimeMillis),
        sleep: (delayMs) => runPromise(Effect.sleep(Duration.millis(delayMs))),
        waitFor,
      };
      const api = yield* platform.createApi(key.route, asyncRuntime);

      // Browser commands are a concurrent protocol: Page.navigate can wait for a response that a
      // simultaneous Fetch.continueResponse command must release. Commands therefore take shared
      // activity leases, while turn teardown takes the whole semaphore and waits for the session
      // to become quiescent before releasing tabs and debugger state.
      const sessionActivity = yield* Semaphore.make(SESSION_ACTIVITY_PERMITS);
      const server = yield* platform
        .createServer((request) =>
          runPromise(
            sessionActivity.withPermit(
              Effect.tryPromise({
                try: () => api.dispatch(request.method, request.params),
                catch: (cause) => runtimeError("dispatch", sessionId, cause),
              }),
            ),
          ),
        )
        .pipe(Effect.mapError((cause) => runtimeError("create-server", sessionId, cause)));

      const disposeCdpListener = yield* Effect.try({
        try: () =>
          api.addCdpEventListener((event) => {
            server.broadcast("onCDPEvent", event);
          }),
        catch: (cause) => runtimeError("listen-cdp", sessionId, cause),
      });
      yield* Effect.addFinalizer(() => Effect.sync(disposeCdpListener));
      const currentTurnId = yield* Ref.make<string | null>(null);
      const completedTurnIds = yield* Ref.make<ReadonlySet<string>>(new Set());
      const disposeAfterSessionActivity = yield* Ref.make(key.initialDisposeAfterSessionActivity);
      const turnLock = yield* Semaphore.make(1);
      yield* record("backend-ready", sessionId);

      const turnEnded = Effect.fn("BrowserUseSession.turnEnded")(
        (input: BrowserUseTurnLifecycleInput) =>
          turnLock.withPermits(1)(
            Effect.gen(function* () {
              const completed = yield* Ref.get(completedTurnIds);
              if (completed.has(input.turnId)) {
                return yield* Ref.get(disposeAfterSessionActivity);
              }
              const current = yield* Ref.get(currentTurnId);
              if (current !== null && current !== input.turnId) {
                yield* record("stale-turn-end-ignored", sessionId, {
                  currentTurnId: current,
                  turnId: input.turnId,
                });
                return false;
              }
              yield* sessionActivity.withPermits(SESSION_ACTIVITY_PERMITS)(
                Effect.tryPromise({
                  try: () =>
                    api.turnEnded({
                      session_id: sessionId,
                      turn_id: input.turnId,
                    }),
                  catch: (cause) => runtimeError("turn-ended", sessionId, cause),
                }),
              );
              yield* Ref.update(completedTurnIds, (latest) => {
                const next = new Set(latest);
                next.add(input.turnId);
                while (next.size > 64) {
                  const oldest = next.values().next().value;
                  if (oldest === undefined) break;
                  next.delete(oldest);
                }
                return next;
              });
              yield* Ref.update(currentTurnId, (latest) =>
                latest === input.turnId ? null : latest,
              );
              yield* record("turn-ended", sessionId, { turnId: input.turnId });
              return yield* Ref.get(disposeAfterSessionActivity);
            }),
          ),
      );

      return BrowserUseSession.of({
        hasActiveControl: Effect.sync(() => api.hasActiveControl()),
        markDisposeAfterSessionActivity: Ref.set(disposeAfterSessionActivity, true),
        notifyCursorArrived: (moveSequence) =>
          Effect.sync(() => api.notifyCursorArrived(moveSequence)),
        pipePath: server.pipePath,
        route: key.route,
        snapshot: Effect.all({
          currentTurnId: Ref.get(currentTurnId),
          disposeAfterSessionActivity: Ref.get(disposeAfterSessionActivity),
        }),
        turnEnded,
        turnStarted: (input) =>
          Ref.set(currentTurnId, input.turnId).pipe(
            Effect.andThen(
              Ref.update(completedTurnIds, (completed) => {
                const next = new Set(completed);
                next.delete(input.turnId);
                return next;
              }),
            ),
            Effect.andThen(record("turn-started", sessionId, { turnId: input.turnId })),
          ),
      });
    }),
  );

const sameRoute = (
  left: BrowserUseRoute,
  right: Pick<
    BrowserUseRoute,
    "browserConversationId" | "browserViewScopeId" | "ownerWebContentsId"
  >,
): boolean =>
  left.browserConversationId === right.browserConversationId &&
  left.browserViewScopeId === right.browserViewScopeId &&
  left.ownerWebContentsId === right.ownerWebContentsId;

export const makeBrowserUseSessionRuntime = (
  enabled: boolean,
  platform: BrowserUseSessionRuntimePlatform,
): Effect.Effect<BrowserUseSessionRuntime, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<RegistryState>({
      active: new Map(),
      events: [],
      nextDebugSequence: 1,
      nextGeneration: 1,
    });
    const mutationLock = yield* Semaphore.make(1);
    const record = (
      kind: string,
      sessionId: string | null,
      details?: Record<string, string | number | boolean | null>,
    ) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((timestampMs) =>
          Ref.update(state, (current) => ({
            ...current,
            events: [
              ...current.events,
              {
                ...(details ? { details } : {}),
                kind,
                sequence: current.nextDebugSequence,
                sessionId,
                timestampMs,
              },
            ].slice(-MAX_DEBUG_EVENTS),
            nextDebugSequence: current.nextDebugSequence + 1,
          })),
        ),
      );
    const sessions = yield* LayerMap.make(
      (key: SessionKey) => sessionLayer(key, platform, record),
      { idleTimeToLive: Duration.infinity },
    );

    const contextFor = (key: SessionKey) =>
      sessions
        .contextEffect(key)
        .pipe(Effect.map((context) => Context.get(context, BrowserUseSession)));
    const removeKey = (key: SessionKey) =>
      Ref.update(state, (current) => {
        if (current.active.get(key.route.codexSessionId) !== key) return current;
        const active = new Map(current.active);
        active.delete(key.route.codexSessionId);
        return { ...current, active };
      }).pipe(Effect.andThen(sessions.invalidate(key)));
    const releaseSession = Effect.fn("BrowserUseSessionRuntime.releaseSession")(
      (sessionId: string) =>
        mutationLock.withPermits(1)(
          Ref.get(state).pipe(
            Effect.flatMap((current) => {
              const key = current.active.get(sessionId);
              if (key === undefined) return Effect.void;
              return removeKey(key).pipe(Effect.andThen(record("session-released", sessionId)));
            }),
          ),
        ),
    );

    const useSessionWithKey = <A>(
      sessionId: string,
      use: (session: BrowserUseSessionService) => Effect.Effect<A, BrowserUseSessionRuntimeError>,
    ): Effect.Effect<
      { readonly key: SessionKey; readonly value: A } | null,
      BrowserUseSessionRuntimeError
    > =>
      Effect.scoped(
        mutationLock
          .withPermits(1)(
            Ref.get(state).pipe(
              Effect.flatMap((current) => {
                const key = current.active.get(sessionId);
                return key === undefined
                  ? Effect.succeed<{
                      readonly key: SessionKey;
                      readonly session: BrowserUseSessionService;
                    } | null>(null)
                  : contextFor(key).pipe(Effect.map((session) => ({ key, session })));
              }),
            ),
          )
          .pipe(
            Effect.flatMap((entry) =>
              entry === null
                ? Effect.succeed(null)
                : use(entry.session).pipe(Effect.map((value) => ({ key: entry.key, value }))),
            ),
          ),
      );

    const useSession = <A>(
      sessionId: string,
      use: (session: BrowserUseSessionService) => Effect.Effect<A, BrowserUseSessionRuntimeError>,
    ): Effect.Effect<A | null, BrowserUseSessionRuntimeError> =>
      useSessionWithKey(sessionId, use).pipe(
        Effect.map((entry) => (entry === null ? null : entry.value)),
      );

    const useExactSession = <A>(
      key: SessionKey,
      use: (session: BrowserUseSessionService) => Effect.Effect<A, BrowserUseSessionRuntimeError>,
    ): Effect.Effect<A | null, BrowserUseSessionRuntimeError> =>
      Effect.scoped(
        mutationLock
          .withPermits(1)(
            Ref.get(state).pipe(
              Effect.flatMap((current) =>
                current.active.get(key.route.codexSessionId) === key
                  ? contextFor(key)
                  : Effect.succeed<BrowserUseSessionService | null>(null),
              ),
            ),
          )
          .pipe(
            Effect.flatMap((session) => (session === null ? Effect.succeed(null) : use(session))),
          ),
      );

    const captureRoute = Effect.fn("BrowserUseSessionRuntime.captureRoute")((
      input: BrowserUseRouteCapture,
    ) => {
      if (!enabled) {
        return Effect.fail(
          runtimeError(
            "capture-route",
            input.codexSessionId,
            new Error("Browser Use IAB backend is unavailable"),
          ),
        );
      }
      const route: BrowserUseRoute = {
        browserConversationId: input.browserConversationId,
        browserViewScopeId: input.browserViewScopeId,
        codexSessionId: input.codexSessionId,
        ownerWebContentsId: input.ownerWebContentsId,
        projectId: input.projectId,
      };
      return Effect.scoped(
        mutationLock.withPermits(1)(
          Effect.gen(function* () {
            if (route.codexSessionId !== route.browserConversationId) {
              const current = yield* Ref.get(state);
              const provisional = current.active.get(route.browserConversationId);
              if (provisional !== undefined && sameRoute(provisional.route, route)) {
                yield* removeKey(provisional);
                yield* record("provisional-route-rebound", route.codexSessionId, {
                  provisionalSessionId: route.browserConversationId,
                });
              }
            }

            const current = yield* Ref.get(state);
            const existingKey = current.active.get(route.codexSessionId);
            if (existingKey !== undefined) {
              const existing = yield* contextFor(existingKey);
              if (sameRoute(existing.route, route)) {
                if (input.disposeAfterSessionActivity === true) {
                  yield* existing.markDisposeAfterSessionActivity;
                }
                return { pipePath: existing.pipePath, route: existing.route };
              }
              if (yield* existing.hasActiveControl) {
                yield* record("route-rebind-rejected", route.codexSessionId, {
                  ownerWebContentsId: route.ownerWebContentsId,
                });
                return yield* Effect.fail(
                  runtimeError(
                    "capture-route",
                    route.codexSessionId,
                    new Error("Browser Use route has live controlled pages"),
                  ),
                );
              }
              yield* removeKey(existingKey);
            }

            const beforeCreate = yield* Ref.get(state);
            const key: SessionKey = {
              generation: beforeCreate.nextGeneration,
              initialDisposeAfterSessionActivity: input.disposeAfterSessionActivity === true,
              route,
            };
            yield* Ref.update(state, (latest) => {
              const active = new Map(latest.active);
              active.set(route.codexSessionId, key);
              return {
                ...latest,
                active,
                nextGeneration: latest.nextGeneration + 1,
              };
            });
            const session = yield* contextFor(key).pipe(Effect.onError(() => removeKey(key)));
            yield* record("route-captured", route.codexSessionId, {
              ownerWebContentsId: route.ownerWebContentsId,
            });
            return { pipePath: session.pipePath, route: session.route };
          }),
        ),
      );
    });

    const turnEnded = Effect.fn("BrowserUseSessionRuntime.turnEnded")(
      (input: BrowserUseTurnLifecycleInput) =>
        useSessionWithKey(input.sessionId, (session) => session.turnEnded(input)).pipe(
          Effect.flatMap((entry) => {
            if (entry?.value !== true) return Effect.void;
            return mutationLock.withPermits(1)(
              Ref.get(state).pipe(
                Effect.flatMap((current) => {
                  if (current.active.get(input.sessionId) !== entry.key) return Effect.void;
                  return removeKey(entry.key).pipe(
                    Effect.andThen(record("session-released", input.sessionId)),
                  );
                }),
              ),
            );
          }),
        ),
    );

    return {
      availableBackends: () => (enabled ? ["iab"] : []),
      captureRoute,
      debugSnapshot: mutationLock.withPermits(1)(
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.active, ([sessionId, key]) =>
              Effect.scoped(contextFor(key)).pipe(
                Effect.flatMap((session) => session.snapshot),
                Effect.map((snapshot) => ({
                  browserConversationId: key.route.browserConversationId,
                  browserViewScopeId: key.route.browserViewScopeId,
                  currentTurnId: snapshot.currentTurnId,
                  disposeAfterSessionActivity: snapshot.disposeAfterSessionActivity,
                  ownerWebContentsId: key.route.ownerWebContentsId,
                  pipeReady: true as const,
                  sessionId,
                })),
              ),
            ).pipe(
              Effect.map((sessionSnapshots) => ({
                events: current.events,
                sessions: sessionSnapshots,
              })),
            ),
          ),
        ),
      ),
      notifyCursorArrived: (input) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) => {
            const match = [...current.active.entries()].find(([, key]) =>
              sameRoute(key.route, input),
            );
            if (match === undefined) return Effect.void;
            return useExactSession(match[1], (session) =>
              session.notifyCursorArrived(input.moveSequence).pipe(
                Effect.andThen(
                  record("cursor-arrived", match[0], {
                    moveSequence: input.moveSequence,
                  }),
                ),
              ),
            ).pipe(Effect.asVoid);
          }),
        ),
      releaseOwner: (ownerWebContentsId) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(
              [...current.active.values()].filter(
                (key) => key.route.ownerWebContentsId === ownerWebContentsId,
              ),
              (key) =>
                mutationLock.withPermits(1)(
                  Ref.get(state).pipe(
                    Effect.flatMap((latest) =>
                      latest.active.get(key.route.codexSessionId) === key
                        ? removeKey(key).pipe(
                            Effect.andThen(record("session-released", key.route.codexSessionId)),
                          )
                        : Effect.void,
                    ),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
      releaseSession,
      turnEnded,
      turnStarted: (input) =>
        useSession(input.sessionId, (session) => session.turnStarted(input)).pipe(Effect.asVoid),
    };
  });
