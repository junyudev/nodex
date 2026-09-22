import type { CodexRendererNativeRequestOrigin } from "./CodexRendererRequestOrigin";
import { randomUUID } from "node:crypto";
import {
  codexHostRequestCanRetainOutcome,
  type CodexRendererRequestCaller,
} from "../../shared/codex-renderer-request";
import { CodexTurnDeliveryError } from "../../shared/codex-conversation-state/codex-turn-delivery";
import type { CodexEndpoint } from "./CodexEndpoint";
import type { CodexAppServerSessionService } from "./CodexAppServerSession";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import {
  CodexRendererRequestOrigin,
  CodexRendererDeliverySink,
  CodexRendererDispatchState,
  matchesRendererNativeRequest,
} from "./CodexRendererRequestOrigin";
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
import { defaultCodexRequestPriority } from "./CodexRequestSchedulerPolicy";
import type { CodexAppServerRequestOptions } from "@nodex/effect-codex-app-server/protocol";
import {
  CodexScheduledRequestTrace,
  CodexRendererResponseMetrics,
} from "./CodexHostRequestMetrics";
import { CodexExecutionHostAuthState } from "./CodexExecutionHostAuthState";
import { isCodexCloudRequirementsAuthFailure } from "../../shared/codex-auth-failure";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import { codexRequestConversationId } from "../../shared/codex-request-lifecycle";
import { runMainTraceSpan } from "../observability/sentry-main";
import { codexRequestTraceCoordinator } from "./CodexRequestTraceCoordinator";

export class CodexThreadHostResolver extends Context.Service<
  CodexThreadHostResolver,
  {
    readonly resolve: (threadId: string) => Effect.Effect<string, CodexRuntimeError>;
  }
>()("nodex/main/codex-runtime/CodexThreadHostResolver") {}

export interface CodexGatewayOptions {
  readonly requestTimeout?: Duration.Input | ((method: ClientRequestMethod) => Duration.Input);
}

/**
 * Pins request admission to the physical host generation whose capabilities the caller checked.
 * The scheduler still owns the final dispatch race: retiring that generation rejects the request
 * before its captured client Effect can run.
 */
export interface CodexGatewayRequestOptions extends Omit<
  CodexRequestScheduleOptions,
  "coalesce" | "hostMetrics"
> {
  readonly expectedHostId?: string;
  readonly expectedGeneration?: number;
  /** W3C trace context written to the physical JSON-RPC request. */
  readonly wireTrace?: CodexRequestTraceContext | null;
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
    : (options.requestTimeout ?? (method === "plugin/list" ? 30_000 : 0));

const OUTCOME_UNKNOWN_ON_TIMEOUT = new Set<string>([
  "thread/fork",
  "thread/inject_items",
  "thread/start",
  "thread/startAeon",
  "turn/start",
  "turn/steer",
]);

const requestWithTransportMetrics = Effect.fnUntraced(function* <Result, Error>(
  method: string,
  params: unknown,
  scheduling: CodexGatewayRequestOptions | undefined,
  transportKind: "stdio" | "websocket",
  rendererCaller:
    | (CodexRendererRequestCaller &
        Partial<Pick<CodexRendererNativeRequestOrigin, "destinationId">>)
    | null,
  request: (options: CodexAppServerRequestOptions) => Effect.Effect<Result, Error>,
  requestId?: string,
) {
  const trace = yield* CodexScheduledRequestTrace;
  let wireTrace = scheduling?.wireTrace ?? null;
  if (wireTrace) {
    wireTrace = runMainTraceSpan(
      {
        name: "app_server.transport_send",
        op: "codex.app_server.transport_send",
        trace: wireTrace,
        attributes: {
          "app_server.method": method,
          "transport.kind": transportKind,
        },
      },
      (activeTrace) => activeTrace ?? wireTrace,
    );
    if (wireTrace) trace?.onWireTrace?.(wireTrace);
  }
  const webContentsId = Number(rendererCaller?.destinationId);
  if (
    rendererCaller?.destinationId &&
    Number.isSafeInteger(webContentsId) &&
    webContentsId > 0 &&
    requestId
  )
    codexRequestTraceCoordinator.trackRequest({
      method,
      requestId,
      threadId: codexRequestConversationId(params),
      trace: wireTrace,
      webContentsId,
    });
  return yield* request({
    requestId,
    trace: trace ?? undefined,
    wireTrace,
    metricsMode: trace ? "deferred" : "internal",
    preserveResponse: requestId !== undefined,
    observeTransport: defaultCodexRequestPriority(method, scheduling?.priority) !== "background",
  });
});

export const live = (
  options: CodexGatewayOptions,
): Layer.Layer<
  CodexGateway,
  never,
  | CodexEndpointMap
  | CodexEventHub
  | CodexRequestScheduler
  | CodexThreadHostResolver
  | CodexExecutionHostAuthState
> =>
  Layer.effect(
    CodexGateway,
    Effect.gen(function* () {
      const endpoints = yield* CodexEndpointMap;
      const eventHub = yield* CodexEventHub;
      const scheduler = yield* CodexRequestScheduler;
      const threadHosts = yield* CodexThreadHostResolver;
      const authState = yield* CodexExecutionHostAuthState;

      const schedulingOptions = (
        endpoint: CodexEndpoint["Service"],
        method: string,
        scheduling: CodexGatewayRequestOptions | undefined,
      ): CodexRequestScheduleOptions => ({
        ...scheduling,
        priority: scheduling?.priority,
        source: scheduling?.source,
        expiresAtMs: scheduling?.expiresAtMs,
        conversationId: scheduling?.conversationId,
        widgetId: scheduling?.widgetId,
        // Main requests own independent response and cancellation lifetimes.
        coalesce: false,
        queuedBytes: scheduling?.queuedBytes,
        onResponseMetrics: scheduling?.onResponseMetrics,
        timeoutMs:
          scheduling?.timeoutMs === undefined
            ? method === "getAuthStatus"
              ? endpoint.metrics.hostKind === "remote-control"
                ? 90_000
                : 30_000
              : Duration.toMillis(timeoutFor(options, method as ClientRequestMethod))
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

      const scheduleNativeRequest = <A>(
        endpoint: CodexEndpoint["Service"],
        hostId: string,
        method: string,
        params: unknown,
        caller: CodexRendererRequestCaller &
          Partial<Pick<CodexRendererNativeRequestOrigin, "destinationId" | "abandonment">>,
        scheduling: CodexGatewayRequestOptions | undefined,
        responseTimeoutOwner: "main" | "caller",
        dispatchNative: (
          session: CodexAppServerSessionService,
        ) => Effect.Effect<A, CodexRuntimeError>,
      ): Effect.Effect<A, CodexRuntimeError> =>
        Effect.gen(function* () {
          const responseMetrics =
            responseTimeoutOwner === "caller" ? yield* CodexRendererResponseMetrics : null;
          const deliverySink =
            responseTimeoutOwner === "caller" ? yield* CodexRendererDeliverySink : null;
          const dispatchState =
            responseTimeoutOwner === "caller" ? yield* CodexRendererDispatchState : null;
          if (responseMetrics?.hostId && responseMetrics.hostId !== hostId)
            return yield* codexRuntimeError({
              operation: "gateway.renderer-host",
              reason: "host-unavailable",
              retryable: false,
              hostId,
              method,
              cause: new Error("Native request host does not match its prepared operation"),
            });
          if (responseMetrics) responseMetrics.hostId = hostId;
          if (responseMetrics) responseMetrics.requestMethod = method;
          const admissionAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const admissionBudget =
            caller.expiresAtMs === null ? null : caller.expiresAtMs - admissionAt;
          const admissionError = () =>
            codexRuntimeError({
              operation: "gateway.renderer-admission",
              reason: "timeout",
              retryable: false,
              hostId,
              method,
              cause: new CodexTurnDeliveryError("App server request timed out while queued", {
                requestId: caller.requestId,
                method,
                stage: "not-sent",
              }),
            });
          if (admissionBudget !== null && admissionBudget <= 0) return yield* admissionError();
          const generation =
            admissionBudget === null
              ? yield* endpoint.admission
              : yield* endpoint.admission.pipe(
                  Effect.timeoutOption(admissionBudget),
                  Effect.flatMap((result) =>
                    Option.isSome(result)
                      ? Effect.succeed(result.value)
                      : Effect.fail(admissionError()),
                  ),
                );
          const awaitReady = Effect.gen(function* () {
            const session = yield* endpoint.session;
            yield* assertExpectedGeneration(hostId, session.generation, session.pid, method, {
              ...scheduling,
              expectedGeneration: scheduling?.expectedGeneration ?? generation,
            });
            return session;
          });
          const deadlineError = () =>
            codexRuntimeError({
              operation: "gateway.renderer-readiness",
              reason: "timeout",
              retryable: false,
              hostId: hostId,
              generation,
              method,
              cause: new CodexTurnDeliveryError(
                "App server request timed out before native readiness",
                {
                  requestId: caller.requestId,
                  method,
                  stage: "not-sent",
                },
              ),
            });
          const dispatch = Effect.gen(function* () {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            const remaining = caller.expiresAtMs === null ? null : caller.expiresAtMs - now;
            if (remaining !== null && remaining <= 0) return yield* deadlineError();
            const session =
              remaining === null
                ? yield* awaitReady
                : yield* awaitReady.pipe(
                    Effect.timeoutOption(remaining),
                    Effect.flatMap((result) =>
                      Option.isSome(result)
                        ? Effect.succeed(result.value)
                        : Effect.fail(deadlineError()),
                    ),
                  );
            const dispatchedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            if (caller.expiresAtMs !== null && dispatchedAt >= caller.expiresAtMs)
              return yield* deadlineError();
            return yield* dispatchNative(session);
          });
          return yield* scheduler.schedule({
            hostId: hostId,
            generation,
            method,
            params,
            dispatch,
            options: {
              ...scheduling,
              requestId: caller.requestId,
              retainResponse: caller.retainResponse,
              onNativeDispatch: dispatchState
                ? () => {
                    dispatchState.dispatched = true;
                    scheduling?.onNativeDispatch?.();
                  }
                : scheduling?.onNativeDispatch,
              onRendererCoalescedRoleBound: dispatchState
                ? (isFollower) => {
                    dispatchState.isCoalescedFollower = isFollower;
                  }
                : undefined,
              onDetachedPhysicalResponse: dispatchState?.onDetachedPhysicalResponse,
              onOutcomeUnknown: deliverySink
                ? (delivery) =>
                    Effect.gen(function* () {
                      yield* deliverySink({
                        type: "mcp-request-delivery",
                        hostId,
                        update: { type: "outcome-unknown", delivery },
                      });
                      if (scheduling?.onOutcomeUnknown)
                        yield* scheduling.onOutcomeUnknown(delivery);
                    })
                : scheduling?.onOutcomeUnknown,
              hostMetrics: endpoint.metrics,
              onResponseMetrics: (metrics) =>
                Effect.gen(function* () {
                  if (responseMetrics) responseMetrics.hostMetrics = metrics;
                  if (scheduling?.onResponseMetrics) yield* scheduling.onResponseMetrics(metrics);
                }),
              onPhysicalResponse: (receivedAtMs) => {
                if (responseMetrics) responseMetrics.responseReceivedAtMs = receivedAtMs;
                scheduling?.onPhysicalResponse?.(receivedAtMs);
              },
              onWireTrace: (wireTrace) => {
                if (responseMetrics) responseMetrics.wireTrace = wireTrace;
                scheduling?.onWireTrace?.(wireTrace);
              },
              conversationId: scheduling?.conversationId,
              timeoutMs: caller.timeoutMs,
              expiresAtMs: caller.expiresAtMs,
              coalesce: responseTimeoutOwner === "caller",
              rendererCaller: caller.destinationId
                ? { destinationId: caller.destinationId, abandonment: caller.abandonment }
                : undefined,
              responseTimeoutOwner,
            },
          });
        });

      const requestOnHostUsing = <A, E>(
        hostId: string,
        method: string,
        params: unknown,
        scheduling: CodexGatewayRequestOptions | undefined,
        invoke: (
          session: CodexAppServerSessionService,
          options: CodexAppServerRequestOptions,
        ) => Effect.Effect<A, E>,
      ): Effect.Effect<A, CodexRuntimeError> =>
        Effect.gen(function* () {
          const enqueuedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const normalizedHostId = hostId.trim();
          yield* assertExpectedHost(normalizedHostId, method, scheduling);
          const endpoint = yield* endpoints.endpoint(normalizedHostId);
          const origin = yield* CodexRendererRequestOrigin;
          const rendererCaller =
            origin && matchesRendererNativeRequest(origin, method, params) ? origin : null;
          const resolved = rendererCaller
            ? { ...scheduling, wireTrace: rendererCaller.wireTrace }
            : { ...scheduling, ...schedulingOptions(endpoint, method, scheduling) };
          const timeoutMs = resolved?.timeoutMs ?? 0;
          const caller = rendererCaller ?? {
            requestId: `${method}:${randomUUID()}`,
            timeoutMs,
            expiresAtMs: resolved?.expiresAtMs ?? (timeoutMs > 0 ? enqueuedAtMs + timeoutMs : null),
            retainResponse: codexHostRequestCanRetainOutcome(method),
          };
          return yield* scheduleNativeRequest(
            endpoint,
            normalizedHostId,
            method,
            params,
            caller,
            resolved,
            rendererCaller ? "caller" : "main",
            (session) =>
              requestWithTransportMetrics(
                method,
                params,
                resolved,
                endpoint.metrics.transportKind,
                rendererCaller,
                (requestOptions) =>
                  authState.withAccountMutation(
                    normalizedHostId,
                    method,
                    invoke(session, requestOptions),
                  ),
                caller.requestId,
              ).pipe(
                Effect.tapError((cause) =>
                  isCodexCloudRequirementsAuthFailure(cause)
                    ? authState.markLoginRequired(normalizedHostId)
                    : Effect.void,
                ),
                Effect.mapError((cause) =>
                  classifyCodexClientError({
                    operation: rendererCaller ? "gateway.renderer-request" : "gateway.request",
                    cause,
                    hostId: normalizedHostId,
                    generation: session.generation,
                    pid: session.pid,
                    method,
                  }),
                ),
              ),
          );
        });

      const requestOnHost = <M extends ClientRequestMethod>(
        hostId: string,
        method: M,
        params: ClientRequestParamsByMethod[M],
        scheduling?: CodexGatewayRequestOptions,
      ): Effect.Effect<ClientRequestResponsesByMethod[M], CodexRuntimeError> =>
        requestOnHostUsing(hostId, method, params, scheduling, (session, options) =>
          session.client.request(method, params, options),
        ).pipe(Effect.withSpan("CodexGateway.request", { attributes: { hostId, method } }));

      const requestRawOnHost = (
        hostId: string,
        method: string,
        params: unknown,
        scheduling?: CodexGatewayRequestOptions,
      ) =>
        requestOnHostUsing(hostId, method, params, scheduling, (session, options) =>
          session.client.raw.request(method, params, options),
        ).pipe(Effect.withSpan("CodexGateway.rawRequest", { attributes: { hostId, method } }));

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
        removeHost: (hostId) =>
          endpoints.unregister(hostId).pipe(Effect.andThen(authState.clearLoginRequired(hostId))),
        restartHost: endpoints.restart,
      });
    }),
  );
