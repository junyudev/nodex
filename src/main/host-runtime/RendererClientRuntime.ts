import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  RENDERER_DELIVERY_DATA_CHANNEL,
  type RendererDeliveryDataEnvelope,
  type RendererDeliveryJsonValue,
  type RendererDeliveryRoutedPayload,
  type RendererDeliveryTarget,
  type RendererDeliveryTransferAbortEnvelope,
  type RendererDeliveryTransferAckEnvelope,
} from "../../shared/renderer-delivery-transport";
import type { CodexRendererClientRequestMessage } from "../../shared/types";
import {
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS,
  DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET,
  DEFAULT_RENDERER_CLIENT_REQUEST_TIMEOUT_MS,
  RENDERER_CLIENT_REQUEST_CHANNEL,
  RendererClientRuntimeError,
  THREAD_ROLE_RENDERER_CLIENT_REQUEST_METHOD,
  type RendererClientConnectedEvent,
  type RendererClientDisposedEvent,
  type RendererClientEvent,
  type RendererClientRegistration,
  type RendererClientRuntimeOptions,
  type RendererClientRuntimeService,
  type RendererClientWebContents,
} from "../codex/renderer-client-runtime-contracts";
import { safeSendToWebContents } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import {
  make as makeRendererDelivery,
  RendererDeliveryAdapter,
  RendererDeliveryAdapterError,
} from "./RendererDelivery";

interface RegisteredRendererClient {
  readonly clientId: string;
  readonly generation: number;
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

interface PendingRendererDeliveryAcknowledgment {
  readonly targetWebContentsId: number;
  readonly result: Deferred.Deferred<
    RendererDeliveryTransferAckEnvelope,
    RendererDeliveryAdapterError
  >;
}

const runtimeLogger = getLogger({ subsystem: "codex", component: "renderer-client-runtime" });

const createClientId = (): string => `renderer:${randomUUID()}`;
const createRequestId = (): string => `renderer-request:${randomUUID()}`;

const acknowledgmentKey = (acknowledgment: RendererDeliveryTransferAckEnvelope): string =>
  JSON.stringify([
    acknowledgment.targetId,
    acknowledgment.generation,
    acknowledgment.transferId,
    acknowledgment.sequence,
  ]);

const targetOf = (client: RegisteredRendererClient): RendererDeliveryTarget => ({
  targetId: client.clientId,
  generation: client.generation,
});

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
        ((target: RendererClientWebContents, channel: string, args: readonly unknown[]) =>
          safeSendToWebContents(target, channel, args, { logger }));
      const events = yield* PubSub.sliding<RendererClientEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
      const callbacks = yield* FiberSet.makeRuntime<never, void, never>();
      const clientsByWebContentsId = new Map<number, RegisteredRendererClient>();
      const webContentsIdByClientId = new Map<string, number>();
      const pendingRequests = new Map<string, PendingRendererClientRequest>();
      const pendingRequestCountByTargetClientId = new Map<string, number>();
      const pendingDeliveryAcknowledgments = new Map<
        string,
        PendingRendererDeliveryAcknowledgment
      >();
      let nextGeneration = 1;

      const deliveryAdapter = RendererDeliveryAdapter.of({
        deliver: (envelope: RendererDeliveryDataEnvelope | RendererDeliveryTransferAbortEnvelope) =>
          Effect.gen(function* () {
            const webContentsId = webContentsIdByClientId.get(envelope.targetId);
            const client =
              webContentsId === undefined ? undefined : clientsByWebContentsId.get(webContentsId);
            if (!client || client.generation !== envelope.generation) {
              return yield* new RendererDeliveryAdapterError({
                operation: `deliver.${envelope.kind}`,
                reason: "unavailable",
                cause: new Error("Renderer delivery target generation is unavailable"),
              });
            }
            if (client.webContents.isDestroyed()) {
              return yield* new RendererDeliveryAdapterError({
                operation: `deliver.${envelope.kind}`,
                reason: "destroyed",
                cause: new Error("Renderer delivery target was destroyed"),
              });
            }

            if (envelope.kind === "inline" || envelope.kind === "transferAbort") {
              if (send(client.webContents, RENDERER_DELIVERY_DATA_CHANNEL, [envelope])) return null;
              return yield* new RendererDeliveryAdapterError({
                operation: `deliver.${envelope.kind}`,
                reason: client.webContents.isDestroyed() ? "destroyed" : "send-failed",
                cause: new Error("Electron rejected renderer delivery"),
              });
            }

            const acknowledgment: RendererDeliveryTransferAckEnvelope = {
              version: envelope.version,
              kind: "transferAck",
              targetId: envelope.targetId,
              generation: envelope.generation,
              transferId: envelope.transferId,
              sequence: envelope.sequence,
            };
            const key = acknowledgmentKey(acknowledgment);
            if (pendingDeliveryAcknowledgments.has(key)) {
              return yield* new RendererDeliveryAdapterError({
                operation: `deliver.${envelope.kind}`,
                reason: "send-failed",
                cause: new Error("Renderer delivery already awaits this acknowledgment"),
              });
            }
            const result = yield* Deferred.make<
              RendererDeliveryTransferAckEnvelope,
              RendererDeliveryAdapterError
            >();
            const pending = { targetWebContentsId: client.webContents.id, result };
            pendingDeliveryAcknowledgments.set(key, pending);
            if (!send(client.webContents, RENDERER_DELIVERY_DATA_CHANNEL, [envelope])) {
              pendingDeliveryAcknowledgments.delete(key);
              return yield* new RendererDeliveryAdapterError({
                operation: `deliver.${envelope.kind}`,
                reason: client.webContents.isDestroyed() ? "destroyed" : "send-failed",
                cause: new Error("Electron rejected renderer delivery"),
              });
            }
            return yield* Deferred.await(result).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (pendingDeliveryAcknowledgments.get(key) === pending) {
                    pendingDeliveryAcknowledgments.delete(key);
                  }
                }),
              ),
            );
          }),
      });
      const rendererDelivery = yield* makeRendererDelivery().pipe(
        Effect.provideService(RendererDeliveryAdapter, deliveryAdapter),
      );

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
            yield* rendererDelivery.releaseTarget(targetOf(removed.client));
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
        const generation = nextGeneration;
        nextGeneration += 1;
        clientsByWebContentsId.set(webContents.id, {
          clientId,
          generation,
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

      const deliverToRegistered = Effect.fn("RendererClientRuntime.deliverToRegistered")((
        client: RegisteredRendererClient,
        channel: string,
        args: readonly unknown[],
      ): Effect.Effect<void> => {
        const payload: RendererDeliveryRoutedPayload = {
          channel,
          args: args as readonly RendererDeliveryJsonValue[],
        };
        return rendererDelivery.enqueue(targetOf(client), payload).pipe(
          Effect.flatMap((receipt) => receipt.completion),
          Effect.catch((error) =>
            Effect.gen(function* () {
              logger.warn("Renderer delivery failed", {
                channel,
                clientId: client.clientId,
                generation: client.generation,
                reason: error.reason,
              });

              // A failed latest revision is not recoverable by waiting for a later message: there
              // may never be one. Revoke this exact renderer generation so owner/follower state is
              // re-elected now and the renderer obtains a fresh generation on its next IPC ingress.
              // The identity fence prevents a late failure from disposing a replacement client.
              if (clientsByWebContentsId.get(client.webContents.id) !== client) return;
              yield* disposeWebContents(client.webContents.id, `delivery-failed:${error.reason}`);
            }),
          ),
          Effect.asVoid,
        );
      });

      const enqueueToRegistered = (
        client: RegisteredRendererClient,
        channel: string,
        args: readonly unknown[],
      ): boolean => {
        callbacks(deliverToRegistered(client, channel, args));
        return true;
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
            if (!send(target.webContents, RENDERER_CLIENT_REQUEST_CHANNEL, [message])) {
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
        (webContents, acknowledgment) =>
          Effect.gen(function* () {
            const webContentsId = webContentsIdByClientId.get(acknowledgment.targetId);
            const client =
              webContentsId === undefined ? undefined : clientsByWebContentsId.get(webContentsId);
            if (
              !client ||
              client.webContents.id !== webContents.id ||
              client.generation !== acknowledgment.generation
            ) {
              logger.warn("Ignored renderer delivery acknowledgment from a stale target", {
                targetId: acknowledgment.targetId,
                generation: acknowledgment.generation,
                webContentsId: webContents.id,
              });
              return false;
            }

            const key = acknowledgmentKey(acknowledgment);
            const pending = pendingDeliveryAcknowledgments.get(key);
            if (!pending) {
              logger.debug("Ignored unknown renderer delivery acknowledgment", {
                targetId: acknowledgment.targetId,
                generation: acknowledgment.generation,
                transferId: acknowledgment.transferId,
                sequence: acknowledgment.sequence,
              });
              return false;
            }
            if (pending.targetWebContentsId !== webContents.id) {
              logger.warn("Ignored renderer delivery acknowledgment from non-target webContents", {
                targetId: acknowledgment.targetId,
                expectedWebContentsId: pending.targetWebContentsId,
                actualWebContentsId: webContents.id,
              });
              return false;
            }

            pendingDeliveryAcknowledgments.delete(key);
            yield* Deferred.succeed(pending.result, acknowledgment);
            return true;
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
        getPendingRequestCount: () => pendingRequests.size,
        sendToClient: (clientId, channel, args) => {
          const client = findClient(clientId);
          return client ? enqueueToRegistered(client, channel, args) : false;
        },
        sendToClients: (clientIds, channel, args, deliveryOptions = {}) => {
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
            if (enqueueToRegistered(client, channel, args)) sentClientIds.push(clientId);
            else failedClientIds.push(clientId);
          }
          return { sentClientIds, unavailableClientIds, failedClientIds };
        },
        broadcast: (channel, args, broadcastOptions = {}) => {
          let sentCount = 0;
          for (const client of clientsByWebContentsId.values()) {
            if (
              broadcastOptions.includeSource === false &&
              broadcastOptions.sourceClientId === client.clientId
            ) {
              continue;
            }
            if (enqueueToRegistered(client, channel, args)) sentCount += 1;
          }
          return sentCount;
        },
        request,
        queryThreadRole: (targetClientId, conversationId, requestOptions) =>
          request(
            targetClientId,
            THREAD_ROLE_RENDERER_CLIENT_REQUEST_METHOD,
            {
              conversationId,
            },
            requestOptions,
          ).pipe(Effect.map((result) => (result === "owner" ? "owner" : "follower"))),
        requireThreadOwner: (targetClientId, conversationId, requestOptions) =>
          request(
            targetClientId,
            THREAD_ROLE_RENDERER_CLIENT_REQUEST_METHOD,
            {
              conversationId,
            },
            requestOptions,
          ).pipe(
            Effect.flatMap((result) =>
              result === "owner"
                ? Effect.void
                : Effect.fail(
                    makeError({
                      message: `no-client-found: renderer client ${targetClientId} is not owner for ${conversationId}`,
                      operation: "require-thread-owner",
                      reason: "not-owner",
                      clientId: targetClientId,
                      method: THREAD_ROLE_RENDERER_CLIENT_REQUEST_METHOD,
                    }),
                  ),
            ),
          ),
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
