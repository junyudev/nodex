import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import {
  CodexApplicationRequestInbox,
  type CodexApplicationRequestSettlement,
} from "./CodexApplicationRequestInbox";
import { CodexAppServerSession, type CodexAppServerSessionService } from "./CodexAppServerSession";
import { CodexEventHub, type CodexEndpointConnection } from "./CodexEventHub";
import { CodexRequestScheduler } from "./CodexRequestScheduler";
import {
  classifyCodexClientError,
  codexRuntimeError,
  type CodexRuntimeError,
} from "./CodexRuntimeError";

export interface CodexEndpointConfig {
  readonly hostId: string;
  readonly sessionLayer: (
    generation: number,
  ) => Layer.Layer<CodexAppServerSession, CodexRuntimeError, CodexSessionTransport>;
  readonly retryBase?: Duration.Input;
  readonly retryCap?: Duration.Input;
  readonly jitter?: boolean;
}

interface ActiveSession {
  readonly scope: Scope.Closeable;
  readonly session: CodexAppServerSessionService;
  readonly termination: Effect.Effect<never, CodexRuntimeError>;
}

export class CodexEndpoint extends Context.Service<
  CodexEndpoint,
  {
    readonly hostId: string;
    readonly state: SubscriptionRef.SubscriptionRef<CodexEndpointConnection>;
    readonly session: Effect.Effect<CodexAppServerSessionService, CodexRuntimeError>;
    /** Rotates the physical generation without replacing the stable host state cell. */
    readonly restart: Effect.Effect<void>;
    /** Publishes a new host config, then rotates the physical generation atomically. */
    readonly reconcile: (config: CodexEndpointConfig) => Effect.Effect<void, CodexRuntimeError>;
  }
>()("nodex/main/codex-runtime/CodexEndpoint") {}

const openingSchedule = (config: CodexEndpointConfig) => {
  const capped = Schedule.min([
    Schedule.exponential(config.retryBase ?? "250 millis"),
    Schedule.spaced(config.retryCap ?? "5 seconds"),
  ]);
  return config.jitter === false ? capped : capped.pipe(Schedule.jittered);
};

export const live = (
  config: CodexEndpointConfig,
): Layer.Layer<
  CodexEndpoint,
  never,
  CodexSessionTransport | CodexEventHub | CodexApplicationRequestInbox | CodexRequestScheduler
> =>
  Layer.effect(
    CodexEndpoint,
    Effect.gen(function* () {
      const hostId = config.hostId.trim();
      const configRef = yield* Ref.make<CodexEndpointConfig>({ ...config, hostId });
      const eventHub = yield* CodexEventHub;
      const requestInbox = yield* CodexApplicationRequestInbox;
      const requestScheduler = yield* CodexRequestScheduler;
      const state = yield* SubscriptionRef.make<CodexEndpointConnection>({
        kind: "connecting",
        hostId,
        generation: 1,
      });
      const generation = yield* Ref.make(0);
      const active = yield* Ref.make<Option.Option<ActiveSession>>(Option.none());
      const restartWake = yield* Queue.sliding<void>(1);

      const publishConnection = Effect.fn("CodexEndpoint.publishConnection")(function* (
        connection: CodexEndpointConnection,
      ) {
        yield* SubscriptionRef.set(state, connection);
        yield* eventHub.publish({ kind: "connection", value: connection });
      });

      const closeActive = Effect.fn("CodexEndpoint.closeActive")(function* () {
        const current = yield* Ref.getAndSet(active, Option.none());
        if (Option.isNone(current)) return;
        yield* Scope.close(current.value.scope, Exit.void);
      });

      const acquireSession = Effect.fn("CodexEndpoint.acquireSession")(function* (
        currentGeneration: number,
        currentConfig: CodexEndpointConfig,
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const attemptScope = yield* Scope.make();
            const acquired = yield* restore(
              Effect.gen(function* () {
                const context = yield* Layer.buildWithScope(
                  currentConfig.sessionLayer(currentGeneration),
                  attemptScope,
                );
                const session = Context.get(context, CodexAppServerSession);
                const requestGeneration = yield* requestInbox
                  .openGeneration(hostId, currentGeneration)
                  .pipe(
                    Effect.provideService(Scope.Scope, attemptScope),
                    Effect.mapError((cause) =>
                      codexRuntimeError({
                        operation: "endpoint.request-generation",
                        reason:
                          cause.reason === "invalid"
                            ? "host-unavailable"
                            : cause.reason === "closed"
                              ? "closing"
                              : "session-lost",
                        retryable: cause.reason === "conflict",
                        hostId,
                        generation: currentGeneration,
                        cause,
                      }),
                    ),
                  );
                yield* requestScheduler
                  .openGeneration(hostId, currentGeneration)
                  .pipe(Effect.provideService(Scope.Scope, attemptScope));

                const classifyIngressError = (operation: string, cause: unknown) =>
                  classifyCodexClientError({
                    operation,
                    cause,
                    hostId,
                    generation: currentGeneration,
                    pid: session.pid,
                  });

                const writeSettlement = Effect.fn("CodexEndpoint.writeApplicationSettlement")(({
                  occurrence,
                  outcome,
                }: CodexApplicationRequestSettlement) => {
                  const write = (() => {
                    switch (outcome.kind) {
                      case "result":
                        return session.client.raw.respond(occurrence.requestId, outcome.value);
                      case "error":
                        return session.client.raw.respondError(occurrence.requestId, outcome.error);
                      case "abandon":
                        return Effect.void;
                    }
                  })();
                  return write.pipe(
                    Effect.mapError((cause) =>
                      classifyCodexClientError({
                        operation: "endpoint.settle-request",
                        cause,
                        hostId,
                        generation: currentGeneration,
                        pid: session.pid,
                        method: occurrence.method,
                      }),
                    ),
                  );
                });

                const requestIngress = session.client.requests.pipe(
                  Stream.runForEach((request) =>
                    requestGeneration
                      .admit({
                        requestId: request.id,
                        protocol: request.protocol,
                        method: request.method,
                        params: request.params,
                      })
                      .pipe(Effect.asVoid),
                  ),
                  Effect.mapError((cause) =>
                    cause._tag === "CodexApplicationRequestGenerationUnavailable"
                      ? codexRuntimeError({
                          operation: "endpoint.request-ingress",
                          reason: "session-lost",
                          retryable: true,
                          hostId,
                          generation: currentGeneration,
                          pid: session.pid,
                          cause,
                        })
                      : classifyIngressError("endpoint.request-ingress", cause),
                  ),
                );
                const notificationIngress = session.client.notifications.pipe(
                  Stream.runForEach((notification) =>
                    requestInbox
                      .publishNotification({
                        hostId,
                        generation: currentGeneration,
                        protocol: notification.protocol,
                        method: notification.method,
                        params: notification.params,
                      })
                      .pipe(
                        Effect.andThen(
                          eventHub.publish({
                            kind: "notification",
                            hostId,
                            generation: currentGeneration,
                            value: notification,
                          }),
                        ),
                      ),
                  ),
                  Effect.mapError((cause) =>
                    classifyIngressError("endpoint.notification-ingress", cause),
                  ),
                );
                const settlementIngress = requestGeneration.settlements.pipe(
                  Stream.runForEach(writeSettlement),
                );
                const consequenceTermination = requestGeneration.termination.pipe(
                  Effect.mapError((cause) =>
                    codexRuntimeError({
                      operation: "endpoint.application-consequence",
                      reason: "session-lost",
                      retryable: true,
                      hostId,
                      generation: currentGeneration,
                      pid: session.pid,
                      cause,
                    }),
                  ),
                );
                const ingressTermination = Effect.raceFirst(
                  consequenceTermination,
                  Effect.raceFirst(
                    requestIngress,
                    Effect.raceFirst(notificationIngress, settlementIngress),
                  ),
                ).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      codexRuntimeError({
                        operation: "endpoint.protocol-ingress",
                        reason: "session-lost",
                        retryable: true,
                        hostId,
                        generation: currentGeneration,
                        pid: session.pid,
                      }),
                    ),
                  ),
                );
                return { session, ingressTermination };
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(attemptScope, Exit.asVoid(exit)) : Effect.void,
              ),
            );
            const owned: ActiveSession = {
              scope: attemptScope,
              session: acquired.session,
              termination: Effect.raceFirst(
                acquired.session.termination,
                acquired.ingressTermination,
              ),
            };
            yield* Ref.set(active, Option.some(owned));
            return owned;
          }),
        );
      });

      const retryPolicy = (currentConfig: CodexEndpointConfig) =>
        openingSchedule(currentConfig).pipe(
          Schedule.setInputType<CodexRuntimeError>(),
          Schedule.while(({ input }) => input.retryable),
          Schedule.tap(({ input, attempt }) =>
            Ref.get(generation).pipe(
              Effect.flatMap((currentGeneration) =>
                publishConnection({
                  kind: "backing-off",
                  hostId,
                  generation: currentGeneration,
                  attempt,
                  error: input,
                }),
              ),
            ),
          ),
        );

      const openAttempt = Effect.fn("CodexEndpoint.openAttempt")(function* (
        currentConfig: CodexEndpointConfig,
      ) {
        const currentGeneration = yield* Ref.updateAndGet(generation, (value) => value + 1);
        yield* publishConnection({ kind: "connecting", hostId, generation: currentGeneration });
        return yield* acquireSession(currentGeneration, currentConfig);
      });

      const runAttempt = Effect.fn("CodexEndpoint.runAttempt")(function* () {
        const currentConfig = yield* Ref.get(configRef);
        const owned = yield* openAttempt(currentConfig).pipe(
          Effect.retry(retryPolicy(currentConfig)),
        );
        const currentGeneration = owned.session.generation;
        yield* publishConnection({
          kind: "ready",
          hostId,
          generation: currentGeneration,
          pid: owned.session.pid,
        });
        return yield* owned.termination;
      });

      const cycle = runAttempt().pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* closeActive();
            if (!error.retryable) return yield* error;
            const currentGeneration = yield* Ref.get(generation);
            yield* publishConnection({
              kind: "backing-off",
              hostId,
              generation: currentGeneration,
              attempt: 1,
              error,
            });
            const currentConfig = yield* Ref.get(configRef);
            yield* Effect.sleep(currentConfig.retryBase ?? "250 millis");
          }),
        ),
      );
      const runUntilRestart = Effect.raceFirst(cycle, Queue.take(restartWake)).pipe(
        Effect.ensuring(closeActive()),
      );
      const supervisor = Effect.forever(
        runUntilRestart.pipe(
          Effect.catch((error) =>
            publishConnection({ kind: "failed", hostId, error }).pipe(
              Effect.andThen(Queue.take(restartWake)),
            ),
          ),
        ),
      );

      yield* Effect.addFinalizer(() =>
        publishConnection({ kind: "closing", hostId }).pipe(
          Effect.andThen(closeActive()),
          Effect.andThen(publishConnection({ kind: "stopped", hostId })),
        ),
      );
      yield* Effect.forkScoped(supervisor);

      const session = SubscriptionRef.changes(state).pipe(
        Stream.filter(
          (connection) =>
            connection.kind === "ready" ||
            connection.kind === "failed" ||
            connection.kind === "stopped",
        ),
        Stream.runHead,
        Effect.scoped,
        Effect.flatMap((connection) => {
          if (Option.isNone(connection) || connection.value.kind === "stopped") {
            return Effect.fail(
              codexRuntimeError({
                operation: "endpoint.session",
                reason: "closing",
                retryable: false,
                hostId,
              }),
            );
          }
          if (connection.value.kind === "failed") return Effect.fail(connection.value.error);
          const ready = connection.value;
          return Ref.get(active).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    codexRuntimeError({
                      operation: "endpoint.session",
                      reason: "session-lost",
                      retryable: true,
                      hostId,
                      generation: ready.generation,
                    }),
                  ),
                onSome: ({ session }) => Effect.succeed(session),
              }),
            ),
          );
        }),
      );
      const restart = Queue.offer(restartWake, undefined).pipe(Effect.asVoid);
      const reconcile = (next: CodexEndpointConfig) => {
        const nextHostId = next.hostId.trim();
        if (nextHostId !== hostId) {
          return Effect.fail(
            codexRuntimeError({
              operation: "endpoint.reconcile",
              reason: "host-unavailable",
              retryable: false,
              hostId: nextHostId,
              cause: new Error(`Cannot re-key stable Codex host '${hostId}' as '${nextHostId}'`),
            }),
          );
        }
        return Ref.set(configRef, { ...next, hostId }).pipe(Effect.andThen(restart));
      };
      return CodexEndpoint.of({ hostId, state, session, restart, reconcile });
    }),
  );
