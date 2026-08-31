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
import {
  classifyCodexClientError,
  codexRuntimeError,
  type CodexRuntimeError,
} from "./CodexRuntimeError";
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

/**
 * Pins request admission to the physical host generation whose capabilities the caller checked.
 * The scheduler still owns the final dispatch race: retiring that generation rejects the request
 * before its captured client Effect can run.
 */
export interface CodexGatewayRequestOptions extends CodexRequestScheduleOptions {
  readonly expectedHostId?: string;
  readonly expectedGeneration?: number;
}

export const codexGatewayGenerationFence = (input: {
  readonly hostId: string;
  readonly generation: number;
}): Pick<CodexGatewayRequestOptions, "expectedHostId" | "expectedGeneration"> => ({
  expectedHostId: input.hostId,
  expectedGeneration: input.generation,
});

export class CodexGateway extends Context.Service<
  CodexGateway,
  {
    readonly localHostId: string;
    readonly events: Stream.Stream<CodexEndpointEvent>;
    readonly requestLocal: <M extends ClientRequestMethod>(
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexGatewayRequestOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    readonly requestOnHost: <M extends ClientRequestMethod>(
      hostId: string,
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexGatewayRequestOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    /** Extension seam for app-server methods absent from the generated public protocol. */
    readonly requestRawOnHost: (
      hostId: string,
      method: string,
      params: unknown,
      scheduling?: CodexGatewayRequestOptions,
    ) => Effect.Effect<unknown, CodexRuntimeError>;
    readonly requestForThread: <M extends ClientRequestMethod>(
      threadId: string,
      method: M,
      params: ClientRequestParamsByMethod[M],
      scheduling?: CodexGatewayRequestOptions,
    ) => Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError>;
    /** Extension seam for app-server methods that have not entered the generated public protocol. */
    readonly requestRawForThread: (
      threadId: string,
      method: string,
      params: unknown,
      scheduling?: CodexGatewayRequestOptions,
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
        scheduling: CodexGatewayRequestOptions | undefined,
      ): CodexRequestScheduleOptions => ({
        priority: scheduling?.priority,
        source: scheduling?.source,
        expiresAtMs: scheduling?.expiresAtMs,
        conversationId: scheduling?.conversationId,
        widgetId: scheduling?.widgetId,
        coalesce: scheduling?.coalesce,
        queuedBytes: scheduling?.queuedBytes,
        timeoutMs:
          scheduling?.timeoutMs === undefined
            ? Duration.toMillis(timeoutFor(options, method as ClientRequestMethod))
            : scheduling.timeoutMs,
        outcomeOnTimeout:
          scheduling?.outcomeOnTimeout ??
          (OUTCOME_UNKNOWN_ON_TIMEOUT.has(method) ? "unknown" : "not-applied"),
      });

      const assertExpectedHost = (
        hostId: string,
        method: string,
        scheduling: CodexGatewayRequestOptions | undefined,
      ): Effect.Effect<void, CodexRuntimeError> => {
        const expectedHostId = scheduling?.expectedHostId?.trim();
        if (!expectedHostId || expectedHostId === hostId) return Effect.void;
        return Effect.fail(
          codexRuntimeError({
            operation: "gateway.generation-fence",
            reason: "session-lost",
            retryable: true,
            hostId,
            method,
            cause: new Error(
              `Expected Codex host '${expectedHostId}' but Thread routing resolved '${hostId}'`,
            ),
          }),
        );
      };

      const assertExpectedGeneration = (
        hostId: string,
        generation: number,
        pid: number,
        method: string,
        scheduling: CodexGatewayRequestOptions | undefined,
      ): Effect.Effect<void, CodexRuntimeError> => {
        const expectedGeneration = scheduling?.expectedGeneration;
        if (expectedGeneration === undefined || expectedGeneration === generation) {
          return Effect.void;
        }
        return Effect.fail(
          codexRuntimeError({
            operation: "gateway.generation-fence",
            reason: "session-lost",
            retryable: true,
            hostId,
            generation: expectedGeneration,
            pid,
            method,
            cause: new Error(
              `Expected Codex generation ${expectedGeneration} but current generation is ${generation}`,
            ),
          }),
        );
      };

      const requestOnHost = <M extends ClientRequestMethod>(
        hostId: string,
        method: M,
        params: ClientRequestParamsByMethod[M],
        scheduling?: CodexGatewayRequestOptions,
      ): Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError> =>
        Effect.gen(function* () {
          const normalizedHostId = hostId.trim();
          yield* assertExpectedHost(normalizedHostId, method, scheduling);
          const endpoint = yield* endpoints.endpoint(normalizedHostId);
          const session = yield* endpoint.session;
          yield* assertExpectedGeneration(
            normalizedHostId,
            session.generation,
            session.pid,
            method,
            scheduling,
          );
          return yield* scheduler.schedule({
            hostId: normalizedHostId,
            generation: session.generation,
            method,
            params,
            options: schedulingOptions(method, scheduling),
            dispatch: session.client.request(method, params).pipe(
              Effect.mapError((cause) =>
                classifyCodexClientError({
                  operation: "gateway.request",
                  cause,
                  hostId: normalizedHostId,
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
        scheduling?: CodexGatewayRequestOptions,
      ) =>
        Effect.gen(function* () {
          const normalizedHostId = hostId.trim();
          yield* assertExpectedHost(normalizedHostId, method, scheduling);
          const endpoint = yield* endpoints.endpoint(normalizedHostId);
          const session = yield* endpoint.session;
          yield* assertExpectedGeneration(
            normalizedHostId,
            session.generation,
            session.pid,
            method,
            scheduling,
          );
          return yield* scheduler.schedule({
            hostId: normalizedHostId,
            generation: session.generation,
            method,
            params,
            options: schedulingOptions(method, scheduling),
            dispatch: session.client.raw.request(method, params).pipe(
              Effect.mapError((cause) =>
                classifyCodexClientError({
                  operation: "gateway.raw-request",
                  cause,
                  hostId: normalizedHostId,
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
