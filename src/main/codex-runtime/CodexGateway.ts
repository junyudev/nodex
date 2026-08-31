import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  ClientNotificationMethod,
  ClientNotificationParamsByMethod,
  ClientRequestMethod,
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { CodexEndpointMap, type CodexExecutionHostConfig } from "./CodexEndpointMap";
import {
  CodexEventHub,
  type CodexEndpointConnection,
  type CodexEndpointEvent,
} from "./CodexEventHub";
import { classifyCodexClientError, type CodexRuntimeError } from "./CodexRuntimeError";
import { CodexRequestScheduler, type CodexRequestScheduleOptions } from "./CodexRequestScheduler";

export class CodexThreadHostResolver extends Context.Service<
  CodexThreadHostResolver,
  {
    readonly resolve: (threadId: string) => Effect.Effect<string, CodexRuntimeError>;
  }
>()("nodex/main/codex-runtime/CodexThreadHostResolver") {}

export interface CodexGatewayOptions {
  readonly requestTimeout: Duration.Input | ((method: ClientRequestMethod) => Duration.Input);
}

export class CodexGateway extends Context.Service<
  CodexGateway,
  {
    readonly localHostId: string;
    readonly events: Stream.Stream<CodexEndpointEvent>;
    readonly requestLocal: <M extends ClientRequestMethod>(
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexRequestScheduleOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    readonly requestOnHost: <M extends ClientRequestMethod>(
      hostId: string,
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexRequestScheduleOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    /** Extension seam for app-server methods absent from the generated public protocol. */
    readonly requestRawOnHost: (
      hostId: string,
      method: string,
      params: unknown,
      scheduling?: CodexRequestScheduleOptions,
    ) => Effect.Effect<unknown, CodexRuntimeError>;
    readonly requestForThread: <M extends ClientRequestMethod>(
      threadId: string,
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexRequestScheduleOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    /** Extension seam for app-server methods that have not entered the generated public protocol. */
    readonly requestRawForThread: (
      threadId: string,
      method: string,
      params: unknown,
      scheduling?: CodexRequestScheduleOptions,
    ) => Effect.Effect<unknown, CodexRuntimeError>;
    readonly notifyLocal: <M extends ClientNotificationMethod>(
      method: M,
      params: ClientNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexRuntimeError>;
    readonly connection: (
      hostId: string,
    ) => Effect.Effect<CodexEndpointConnection, CodexRuntimeError>;
    readonly connectionChanges: (
      hostId: string,
    ) => Stream.Stream<CodexEndpointConnection, CodexRuntimeError>;
    readonly awaitReady: (hostId: string) => Effect.Effect<void, CodexRuntimeError>;
    readonly reconcileHost: (
      config: CodexExecutionHostConfig,
    ) => Effect.Effect<void, CodexRuntimeError>;
    readonly removeHost: (hostId: string) => Effect.Effect<void, CodexRuntimeError>;
    readonly restartHost: (hostId: string) => Effect.Effect<void, CodexRuntimeError>;
  }
>()("nodex/main/codex-runtime/CodexGateway") {}

const timeoutFor = (options: CodexGatewayOptions, method: ClientRequestMethod): Duration.Input =>
  typeof options.requestTimeout === "function"
    ? options.requestTimeout(method)
    : options.requestTimeout;

const OUTCOME_UNKNOWN_ON_TIMEOUT = new Set<string>([
  "thread/fork",
  "thread/inject_items",
  "thread/start",
  "thread/startAeon",
  "turn/start",
  "turn/steer",
]);

export const live = (
  options: CodexGatewayOptions,
): Layer.Layer<
  CodexGateway,
  never,
  CodexEndpointMap | CodexEventHub | CodexRequestScheduler | CodexThreadHostResolver
> =>
  Layer.effect(
    CodexGateway,
    Effect.gen(function* () {
      const endpoints = yield* CodexEndpointMap;
      const eventHub = yield* CodexEventHub;
      const scheduler = yield* CodexRequestScheduler;
      const threadHosts = yield* CodexThreadHostResolver;

      const schedulingOptions = (
        method: string,
        scheduling: CodexRequestScheduleOptions | undefined,
      ): CodexRequestScheduleOptions => ({
        ...scheduling,
        timeoutMs:
          scheduling?.timeoutMs === undefined
            ? Duration.toMillis(timeoutFor(options, method as ClientRequestMethod))
            : scheduling.timeoutMs,
        outcomeOnTimeout:
          scheduling?.outcomeOnTimeout ??
          (OUTCOME_UNKNOWN_ON_TIMEOUT.has(method) ? "unknown" : "not-applied"),
      });

      const requestOnHost = <M extends ClientRequestMethod>(
        hostId: string,
        method: M,
        params: ClientRequestParamsByMethod[M],
        scheduling?: CodexRequestScheduleOptions,
      ): Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError> =>
        Effect.gen(function* () {
          const endpoint = yield* endpoints.endpoint(hostId);
          const session = yield* endpoint.session;
          return yield* scheduler.schedule({
            hostId,
            generation: session.generation,
            method,
            params,
            options: schedulingOptions(method, scheduling),
            dispatch: session.client.request(method, params).pipe(
              Effect.mapError((cause) =>
                classifyCodexClientError({
                  operation: "gateway.request",
                  cause,
                  hostId,
                  generation: session.generation,
                  pid: session.pid,
                  method,
                }),
              ),
            ),
          });
        }).pipe(Effect.withSpan("CodexGateway.request", { attributes: { hostId, method } }));

      const requestRawOnHost = (
        hostId: string,
        method: string,
        params: unknown,
        scheduling?: CodexRequestScheduleOptions,
      ) =>
        Effect.gen(function* () {
          const endpoint = yield* endpoints.endpoint(hostId);
          const session = yield* endpoint.session;
          return yield* scheduler.schedule({
            hostId,
            generation: session.generation,
            method,
            params,
            options: schedulingOptions(method, scheduling),
            dispatch: session.client.raw.request(method, params).pipe(
              Effect.mapError((cause) =>
                classifyCodexClientError({
                  operation: "gateway.raw-request",
                  cause,
                  hostId,
                  generation: session.generation,
                  pid: session.pid,
                  method,
                }),
              ),
            ),
          });
        }).pipe(Effect.withSpan("CodexGateway.rawRequest", { attributes: { hostId, method } }));

      const events = eventHub.events.pipe(
        Stream.filterEffect((event) => {
          if (event.kind === "connection") return Effect.succeed(true);
          return endpoints.endpoint(event.hostId).pipe(
            Effect.flatMap((endpoint) => SubscriptionRef.get(endpoint.state)),
            Effect.map(
              (connection) =>
                connection.kind === "ready" && connection.generation === event.generation,
            ),
            Effect.orElseSucceed(() => false),
          );
        }),
      );

      return CodexGateway.of({
        localHostId: endpoints.localHostId,
        events,
        requestLocal: (method, params, scheduling) =>
          requestOnHost(endpoints.localHostId, method, params, scheduling),
        requestOnHost,
        requestRawOnHost,
        requestForThread: (threadId, method, params, scheduling) =>
          threadHosts
            .resolve(threadId)
            .pipe(
              Effect.flatMap((hostId) =>
                requestOnHost(hostId, method, params, { ...scheduling, conversationId: threadId }),
              ),
            ),
        requestRawForThread: (threadId, method, params, scheduling) =>
          threadHosts.resolve(threadId).pipe(
            Effect.flatMap((hostId) =>
              requestRawOnHost(hostId, method, params, {
                ...scheduling,
                conversationId: threadId,
              }),
            ),
          ),
        notifyLocal: (method, params) =>
          Effect.gen(function* () {
            const endpoint = yield* endpoints.endpoint(endpoints.localHostId);
            const session = yield* endpoint.session;
            yield* session.client.notify(method, params).pipe(
              Effect.mapError((cause) =>
                classifyCodexClientError({
                  operation: "gateway.notify",
                  cause,
                  hostId: endpoints.localHostId,
                  generation: session.generation,
                  pid: session.pid,
                  method,
                }),
              ),
            );
          }),
        connection: (hostId) =>
          endpoints
            .endpoint(hostId)
            .pipe(Effect.flatMap((endpoint) => SubscriptionRef.get(endpoint.state))),
        connectionChanges: (hostId) =>
          Stream.unwrap(
            endpoints
              .endpoint(hostId)
              .pipe(Effect.map((endpoint) => SubscriptionRef.changes(endpoint.state))),
          ),
        awaitReady: (hostId) =>
          endpoints.endpoint(hostId).pipe(
            Effect.flatMap((endpoint) => endpoint.session),
            Effect.asVoid,
          ),
        reconcileHost: endpoints.register,
        removeHost: endpoints.unregister,
        restartHost: endpoints.restart,
      });
    }),
  );
