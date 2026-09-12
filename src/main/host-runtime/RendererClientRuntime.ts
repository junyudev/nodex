import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { CodexRendererClientRequestMessage } from "../../shared/types";
import {
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
  DEFAULT_RENDERER_CLIENT_REQUEST_TIMEOUT_MS,
  RENDERER_CLIENT_REQUEST_CHANNEL,
  RendererClientRuntimeError,
  type RendererClientConnectedEvent,
  type RendererClientDisposedEvent,
  type RendererClientEvent,
  type RendererClientRegistration,
  type RendererClientRuntimeOptions,
  type RendererClientRuntimeService,
  type RendererClientWebContents,
} from "../codex/renderer-client-runtime-contracts";
import { getLogger } from "../logging/logger";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import { CodexHostChunkedMessageSender } from "./CodexHostChunkedMessageSender";

interface RegisteredRendererClient {
  readonly clientId: string;
  readonly webContents: RendererClientWebContents;
  readonly destroyListener: () => void;
}

interface PendingRendererClientRequest {
  readonly requestId: string;
  readonly method: string;
  readonly targetClientId: string;
  readonly targetWebContentsId: number;
  readonly result: Deferred.Deferred<unknown, RendererClientRuntimeError>;
}

const runtimeLogger = getLogger({ subsystem: "codex", component: "renderer-client-runtime" });

const createClientId = (): string => `renderer:${randomUUID()}`;
const createRequestId = (): string => `renderer-request:${randomUUID()}`;

const rendererDeliveryPayloadType = (channel: string, payload: unknown): string | null => {
  if (channel !== "codex:event") return null;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const type = Reflect.get(payload, "type");
  return typeof type === "string" ? type : null;
};

const rendererDeliveryCauseMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const makeError = (input: {
  readonly message: string;
  readonly operation: string;
  readonly reason: RendererClientRuntimeError["reason"];
  readonly clientId?: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly timeoutMs?: number;
}): RendererClientRuntimeError => new RendererClientRuntimeError(input);

export class RendererClientRuntime extends Context.Service<
  RendererClientRuntime,
  RendererClientRuntimeService
>()("nodex/main/host-runtime/RendererClientRuntime") {}

export const live = (
  options: RendererClientRuntimeOptions = {},
): Layer.Layer<RendererClientRuntime> =>
  Layer.effect(
    RendererClientRuntime,
    Effect.gen(function* () {
      const clientIdFactory = options.clientIdFactory ?? createClientId;
      const requestIdFactory = options.requestIdFactory ?? createRequestId;
      const defaultTimeoutMs =
        options.defaultRequestTimeoutMs ?? DEFAULT_RENDERER_CLIENT_REQUEST_TIMEOUT_MS;
      const maxPendingRequests = Math.max(
        1,
        Math.floor(options.maxPendingRequests ?? DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS),
      );
      const maxPendingRequestsPerTarget = Math.max(
        1,
        Math.floor(
          options.maxPendingRequestsPerTarget ??
            DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
        ),
      );
      const logger = options.logger ?? runtimeLogger;
      const send =
        options.send ??
        ((target: RendererClientWebContents, channel: string, payload: unknown) => {
          if (target.isDestroyed()) return false;
          target.send(channel, payload);
          return true;
        });
      const events = yield* PubSub.sliding<RendererClientEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
      const callbacks = yield* FiberSet.makeRuntime<never, void, never>();
      const clientsByWebContentsId = new Map<number, RegisteredRendererClient>();
      const webContentsIdByClientId = new Map<string, number>();
      const pendingRequests = new Map<string, PendingRendererClientRequest>();
      const pendingRequestCountByTargetClientId = new Map<string, number>();

      type WindowMessage = { readonly channel: string; readonly payload: unknown };
      type LoadingLifecycleTarget = RendererClientWebContents & {
        readonly on?: (
          event: "did-start-loading" | "did-stop-loading",
          listener: () => void,
        ) => unknown;
        readonly removeListener?: (
          event: "destroyed" | "did-start-loading" | "did-stop-loading",
          listener: () => void,
        ) => unknown;
      };
      const chunkedMessageSender = new CodexHostChunkedMessageSender<
        RendererClientWebContents,
        WindowMessage
      >({
        deliver: (target, message, part) => {
          if (!send(target, message.channel, part ?? message.payload)) {
            throw new Error("Renderer target is unavailable");
          }
        },
        getPayload: (message) => message.payload,
        isAvailable: (target) => !target.isDestroyed(),
        isLoading: (target) => target.isLoading?.() === true,
        onSendError: (target, cause) => {
          logger.warn("Chunked renderer message send failed", {
            webContentsId: target.id,
            cause: rendererDeliveryCauseMessage(cause),
          });
        },
        retryDelayMs: 1_000,
        scheduleRetry: (callback, delayMs) => {
          const fiber = callbacks(
            Effect.sleep(delayMs).pipe(Effect.andThen(Effect.sync(callback))),
          );
          return () => {
            callbacks(Fiber.interrupt(fiber).pipe(Effect.asVoid));
          };
        },
        subscribe: (target, callbacks) => {
          const lifecycleTarget = target as LoadingLifecycleTarget;
          target.once?.("destroyed", callbacks.onDestroyed);
          lifecycleTarget.on?.("did-start-loading", callbacks.onLoading);
          lifecycleTarget.on?.("did-stop-loading", callbacks.onLoaded);
          return () => {
            lifecycleTarget.removeListener?.("destroyed", callbacks.onDestroyed);
            lifecycleTarget.removeListener?.("did-start-loading", callbacks.onLoading);
            lifecycleTarget.removeListener?.("did-stop-loading", callbacks.onLoaded);
          };
        },
      });

      const publish = (event: RendererClientEvent): Effect.Effect<void> =>
        PubSub.publish(events, event).pipe(Effect.asVoid);

      const deletePending = (
        requestId: string,
        expected: PendingRendererClientRequest,
      ): boolean => {
        if (pendingRequests.get(requestId) !== expected) return false;
        pendingRequests.delete(requestId);
        const nextCount =
          (pendingRequestCountByTargetClientId.get(expected.targetClientId) ?? 1) - 1;
        if (nextCount <= 0) pendingRequestCountByTargetClientId.delete(expected.targetClientId);
        else pendingRequestCountByTargetClientId.set(expected.targetClientId, nextCount);
        return true;
      };

      const removePending = (
        requestId: string,
        expected: PendingRendererClientRequest,
      ): Effect.Effect<void> => Effect.sync(() => void deletePending(requestId, expected));

      const disposeWebContents = Effect.fn("RendererClientRuntime.disposeWebContents")(
        (webContentsId: number, reason = "disposed"): Effect.Effect<void> =>
          Effect.gen(function* () {
            const removed = yield* Effect.sync(() => {
              const client = clientsByWebContentsId.get(webContentsId);
              if (!client) return null;
              clientsByWebContentsId.delete(webContentsId);
              webContentsIdByClientId.delete(client.clientId);
              const pending = [...pendingRequests.values()].filter(
                (entry) => entry.targetWebContentsId === webContentsId,
              );
              for (const entry of pending) deletePending(entry.requestId, entry);
              return { client, pending };
            });
            if (!removed) return;

            removed.client.webContents.off?.("destroyed", removed.client.destroyListener);
            chunkedMessageSender.dispose(removed.client.webContents);
            const error = makeError({
              message: `Renderer client ${removed.client.clientId} was ${reason}`,
              operation: "dispose-client",
              reason: reason === "runtime-closed" ? "closing" : "unavailable",
              clientId: removed.client.clientId,
            });
            yield* Effect.forEach(
              removed.pending,
              (pending) => Deferred.fail(pending.result, error),
              { discard: true },
            );
            yield* publish({
              kind: "disposed",
              clientId: removed.client.clientId,
              webContentsId,
              reason,
            } satisfies RendererClientDisposedEvent);
          }),
      );

      const createRegistration = (
        clientId: string,
        webContentsId: number,
      ): RendererClientRegistration => ({
        clientId,
        webContentsId,
        release: Effect.suspend(() => {
          if (clientsByWebContentsId.get(webContentsId)?.clientId !== clientId) return Effect.void;
          return disposeWebContents(webContentsId);
        }),
      });

      const register = (webContents: RendererClientWebContents): RendererClientRegistration => {
        if (webContents.isDestroyed()) {
          throw makeError({
            message: `Cannot register destroyed renderer webContents ${webContents.id}`,
            operation: "register",
            reason: "unavailable",
          });
        }
        const existing = clientsByWebContentsId.get(webContents.id);
        if (existing) return createRegistration(existing.clientId, webContents.id);

        const clientId = clientIdFactory();
        const destroyListener = () => {
          callbacks(disposeWebContents(webContents.id, "destroyed"));
        };
        clientsByWebContentsId.set(webContents.id, {
          clientId,
          webContents,
          destroyListener,
        });
        webContentsIdByClientId.set(clientId, webContents.id);
        webContents.once?.("destroyed", destroyListener);
        callbacks(
          publish({
            kind: "connected",
            clientId,
            webContentsId: webContents.id,
          } satisfies RendererClientConnectedEvent),
        );
        return createRegistration(clientId, webContents.id);
      };

      const findClient = (clientId: string): RegisteredRendererClient | null => {
        const webContentsId = webContentsIdByClientId.get(clientId);
        if (webContentsId === undefined) return null;
        const client = clientsByWebContentsId.get(webContentsId);
        if (!client || client.webContents.isDestroyed()) {
          callbacks(disposeWebContents(webContentsId, "destroyed"));
          return null;
        }
        return client;
      };

      const enqueueToRegistered = (
        client: RegisteredRendererClient,
        channel: string,
        payload: unknown,
        priority: "normal" | "critical" = "normal",
      ): boolean => {
        try {
          const message = { channel, payload } satisfies WindowMessage;
          if (priority === "critical")
            chunkedMessageSender.sendCritical(client.webContents, message);
          else chunkedMessageSender.send(client.webContents, message);
          return true;
        } catch (cause) {
          logger.warn("Renderer message send failed", {
            channel,
            payloadType: rendererDeliveryPayloadType(channel, payload),
            clientId: client.clientId,
            cause: rendererDeliveryCauseMessage(cause),
          });
          return false;
        }
      };

      const request = Effect.fn("RendererClientRuntime.request")(
        <A = unknown>(
          targetClientId: string,
          method: string,
          params: unknown,
          requestOptions: { readonly timeoutMs?: number } = {},
        ): Effect.Effect<A, RendererClientRuntimeError> =>
          Effect.gen(function* () {
            const target = findClient(targetClientId);
            if (!target) {
              return yield* makeError({
                message: `Renderer client ${targetClientId} is unavailable`,
                operation: "request",
                reason: "unavailable",
                clientId: targetClientId,
                method,
              });
            }

            const requestId = requestIdFactory();
            const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
            const targetPendingCount = pendingRequestCountByTargetClientId.get(targetClientId) ?? 0;
            if (
              pendingRequests.size >= maxPendingRequests ||
              targetPendingCount >= maxPendingRequestsPerTarget
            ) {
              return yield* makeError({
                message: `Renderer client request capacity is exhausted for ${targetClientId}`,
                operation: "request-admission",
                reason: "pressure",
                clientId: targetClientId,
                requestId,
                method,
              });
            }
            const result = yield* Deferred.make<unknown, RendererClientRuntimeError>();
            const pending: PendingRendererClientRequest = {
              requestId,
              method,
              targetClientId,
              targetWebContentsId: target.webContents.id,
              result,
            };
            const message: CodexRendererClientRequestMessage = { requestId, method, params };
            pendingRequests.set(requestId, pending);
            pendingRequestCountByTargetClientId.set(targetClientId, targetPendingCount + 1);
            if (!enqueueToRegistered(target, RENDERER_CLIENT_REQUEST_CHANNEL, message)) {
              deletePending(requestId, pending);
              return yield* makeError({
                message: `Renderer client ${targetClientId} is unavailable`,
                operation: "request-send",
                reason: "unavailable",
                clientId: targetClientId,
                requestId,
                method,
              });
            }

            return (yield* Deferred.await(result).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () =>
                  Effect.fail(
                    makeError({
                      message: `Renderer client request ${method} timed out after ${timeoutMs}ms`,
                      operation: "request-timeout",
                      reason: "timeout",
                      clientId: targetClientId,
                      requestId,
                      method,
                      timeoutMs,
                    }),
                  ),
              }),
              Effect.ensuring(removePending(requestId, pending)),
            )) as A;
          }),
      );

      const handleResponse: RendererClientRuntimeService["handleResponse"] = (
        webContents,
        response,
      ) =>
        Effect.gen(function* () {
          const pending = pendingRequests.get(response.requestId);
          if (!pending) {
            logger.debug("Ignored renderer response for unknown request", {
              requestId: response.requestId,
              webContentsId: webContents.id,
            });
            return false;
          }
          if (pending.targetWebContentsId !== webContents.id) {
            logger.warn("Ignored renderer response from non-target webContents", {
              requestId: response.requestId,
              expectedWebContentsId: pending.targetWebContentsId,
              actualWebContentsId: webContents.id,
            });
            return false;
          }

          deletePending(response.requestId, pending);
          if (response.type === "error") {
            yield* Deferred.fail(
              pending.result,
              makeError({
                message: response.error || `Renderer client request ${pending.method} failed`,
                operation: "response",
                reason: "request-failed",
                clientId: pending.targetClientId,
                requestId: pending.requestId,
                method: pending.method,
              }),
            );
            return true;
          }
          yield* Deferred.succeed(pending.result, response.result);
          return true;
        });

      const handleDeliveryAcknowledgment: RendererClientRuntimeService["handleDeliveryAcknowledgment"] =
        (webContents, transferId, sequence) =>
          Effect.sync(() => {
            const client = clientsByWebContentsId.get(webContents.id);
            if (!client || client.webContents !== webContents) return;
            chunkedMessageSender.acknowledge(webContents, transferId, sequence);
          });

      const disposeAll = Effect.fn("RendererClientRuntime.disposeAll")(() =>
        Effect.forEach(
          [...clientsByWebContentsId.keys()],
          (webContentsId) => disposeWebContents(webContentsId, "runtime-closed"),
          { discard: true },
        ).pipe(
          Effect.andThen(
            Effect.forEach(
              [...pendingRequests.values()],
              (pending) =>
                Deferred.fail(
                  pending.result,
                  makeError({
                    message: "Renderer client runtime was closed",
                    operation: "runtime-close",
                    reason: "closing",
                    clientId: pending.targetClientId,
                    requestId: pending.requestId,
                    method: pending.method,
                  }),
                ),
              { discard: true },
            ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              pendingRequests.clear();
              pendingRequestCountByTargetClientId.clear();
            }),
          ),
          Effect.andThen(PubSub.shutdown(events)),
          Effect.asVoid,
        ),
      );
      yield* Effect.addFinalizer(disposeAll);

      const runtime: RendererClientRuntimeService = {
        register,
        ensureClient: register,
        getClientIdForWebContentsId: (webContentsId) =>
          clientsByWebContentsId.get(webContentsId)?.clientId ?? null,
        getWebContentsIdForClientId: (clientId) => webContentsIdByClientId.get(clientId) ?? null,
        getClientCount: () => clientsByWebContentsId.size,
        getClientIds: () => [...webContentsIdByClientId.keys()],
        getPendingRequestCount: () => pendingRequests.size,
        sendToClient: (clientId, channel, payload) => {
          const client = findClient(clientId);
          return client ? enqueueToRegistered(client, channel, payload) : false;
        },
        sendCriticalToClient: (clientId, channel, payload) => {
          const client = findClient(clientId);
          return client ? enqueueToRegistered(client, channel, payload, "critical") : false;
        },
        sendToClients: (clientIds, channel, payload, deliveryOptions = {}) => {
          const sentClientIds: string[] = [];
          const unavailableClientIds: string[] = [];
          const failedClientIds: string[] = [];
          for (const clientId of new Set(clientIds)) {
            if (clientId === deliveryOptions.excludeClientId) continue;
            const client = findClient(clientId);
            if (!client) {
              unavailableClientIds.push(clientId);
              continue;
            }
            if (enqueueToRegistered(client, channel, payload)) sentClientIds.push(clientId);
            else failedClientIds.push(clientId);
          }
          return { sentClientIds, unavailableClientIds, failedClientIds };
        },
        broadcast: (channel, payload, broadcastOptions = {}) => {
          let sentCount = 0;
          for (const client of clientsByWebContentsId.values()) {
            if (
              broadcastOptions.includeSource === false &&
              broadcastOptions.sourceClientId === client.clientId
            ) {
              continue;
            }
            if (enqueueToRegistered(client, channel, payload)) sentCount += 1;
          }
          return sentCount;
        },
        request,
        handleResponse,
        handleDeliveryAcknowledgment,
        disposeClient: (clientId, reason = "disposed") => {
          const webContentsId = webContentsIdByClientId.get(clientId);
          return webContentsId === undefined
            ? Effect.void
            : disposeWebContents(webContentsId, reason);
        },
        events: Stream.fromPubSub(events),
      };
      return RendererClientRuntime.of(runtime);
    }),
  );
