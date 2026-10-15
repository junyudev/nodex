import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
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

const runtimeLogger = getLogger({ subsystem: "codex", component: "renderer-client-runtime" });

const createClientId = (): string => `renderer:${randomUUID()}`;

const rendererDeliveryPayloadType = (channel: string, payload: unknown): string | null => {
  if (channel !== "codex:event") return null;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const type = Reflect.get(payload, "type");
  return typeof type === "string" ? type : null;
};

const rendererDeliveryCauseMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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

      const disposeWebContents = Effect.fn("RendererClientRuntime.disposeWebContents")(
        (webContentsId: number, reason = "disposed"): Effect.Effect<void> =>
          Effect.gen(function* () {
            const removed = yield* Effect.sync(() => {
              const client = clientsByWebContentsId.get(webContentsId);
              if (!client) return null;
              clientsByWebContentsId.delete(webContentsId);
              webContentsIdByClientId.delete(client.clientId);
              return client;
            });
            if (!removed) return;

            removed.webContents.off?.("destroyed", removed.destroyListener);
            chunkedMessageSender.dispose(removed.webContents);
            yield* publish({
              kind: "disposed",
              clientId: removed.clientId,
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
          throw new Error(`Cannot register destroyed renderer webContents ${webContents.id}`);
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
        ).pipe(Effect.andThen(PubSub.shutdown(events)), Effect.asVoid),
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
