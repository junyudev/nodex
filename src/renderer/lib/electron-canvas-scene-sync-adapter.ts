import {
  canonicalizeCanvasPresenceRealtimeEvent,
  type CanvasPresenceCommandResult,
  type CanvasPresencePublishRequest,
  type CanvasPresenceRealtimeEvent,
  type CanvasSceneMutationCommandResult,
  type CanvasSceneMutationError,
  type CanvasSceneRealtimeEvent,
  type CanvasSceneSubscribeRequest,
  type CanvasSceneSubscriptionCommandResult,
  type CanvasSceneSyncCommandResult,
} from "../../shared/block-documents";
import type { CanvasSceneSyncAdapter } from "./canvas-scene-provider";
import type { ElectronRendererBridge } from "./electron-renderer-transport";
import {
  contentAccessContextKey,
  type ContentAccessIdentity,
} from "../../shared/content-access-context";
import {
  createExactRemoteSubscriptionLifecycle,
  type ExactRemoteSubscriptionLifecycle,
} from "./exact-remote-subscription-lifecycle";
import { canvasSceneMutationCommand } from "./canvas-local-scene-commands";
import { invokeLocalCommitCommandResultThrough } from "./renderer-command";

const transportFailure = (error: unknown): CanvasSceneMutationError => ({
  code: "unknown",
  message: error instanceof Error ? error.message : String(error),
  retryable: true,
  resetRequired: false,
});

interface ElectronCanvasSubscriber {
  readonly listener: (event: CanvasSceneRealtimeEvent) => void;
  readonly presenceListener?: (event: CanvasPresenceRealtimeEvent) => void;
}

interface ElectronCanvasSubscription {
  readonly subscribers: Set<ElectronCanvasSubscriber>;
  readonly lifecycle: ExactRemoteSubscriptionLifecycle<CanvasSceneSubscriptionCommandResult>;
}

export const createElectronCanvasSceneSyncAdapter = (
  bridge: ElectronRendererBridge,
  identity: ContentAccessIdentity,
): CanvasSceneSyncAdapter => {
  const accessKey = contentAccessContextKey(identity.accessContext);
  const subscriptions = new Map<string, ElectronCanvasSubscription>();
  const invoke = async <T>(channel: string, request: unknown): Promise<T> =>
    (await bridge.invoke(channel, request)) as T;
  const invokeSubscription = async (
    channel: string,
    request: CanvasSceneSubscribeRequest,
  ): Promise<CanvasSceneSubscriptionCommandResult> => {
    try {
      return await invoke(channel, request);
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }
  };
  const ensureRemoteSubscription = (
    entry: ElectronCanvasSubscription,
  ): Promise<CanvasSceneSubscriptionCommandResult> => entry.lifecycle.ensure();
  return {
    subscribe(request, listener, presenceListener) {
      if (contentAccessContextKey(request.accessContext) !== accessKey) {
        throw new TypeError("Canvas subscription crossed its access boundary");
      }
      const key = JSON.stringify([request.documentId, request.clientSessionId]);
      let entry = subscriptions.get(key);
      if (!entry) {
        const subscribers = new Set<ElectronCanvasSubscriber>();
        const fullRequest = { version: 1 as const, ...request };
        const removeBridgeListener = bridge.on("document-sync:event", (...args: unknown[]) => {
          const event = args[0] as CanvasSceneRealtimeEvent | CanvasPresenceRealtimeEvent;
          if (
            event &&
            "type" in event &&
            (event.type === "canvas_presence_snapshot" || event.type === "canvas_presence_updated")
          ) {
            try {
              const presenceEvent = canonicalizeCanvasPresenceRealtimeEvent(event);
              const documentId =
                presenceEvent.type === "canvas_presence_snapshot"
                  ? presenceEvent.documentId
                  : presenceEvent.presence.documentId;
              if (
                presenceEvent.libraryId === identity.libraryId &&
                contentAccessContextKey(presenceEvent.accessContext) === accessKey &&
                documentId === request.documentId
              ) {
                subscribers.forEach((subscriber) => subscriber.presenceListener?.(presenceEvent));
              }
            } catch {
              // Invalid Host presence never crosses the adapter boundary.
            }
            return;
          }
          if (
            !event ||
            (event.type !== "canvas_scene_committed" &&
              event.type !== "canvas_scene_resync_required") ||
            event.libraryId !== identity.libraryId ||
            contentAccessContextKey(event.accessContext) !== accessKey ||
            event.documentId !== request.documentId
          ) {
            return;
          }
          subscribers.forEach((subscriber) => subscriber.listener(event));
        });
        const lifecycle =
          createExactRemoteSubscriptionLifecycle<CanvasSceneSubscriptionCommandResult>({
            hasSubscribers: () => subscribers.size > 0,
            open: async () => await invokeSubscription("canvas-scene:subscribe", fullRequest),
            isOpenResult: (result) => result.ok,
            alreadyOpenResult: () => ({
              ok: true,
              value: { subscribed: true },
            }),
            inactiveResult: () => ({
              ok: false,
              error: {
                code: "access_scope_mismatch",
                message: "Canvas scene subscription is not active",
                retryable: false,
                resetRequired: false,
              },
            }),
            close: async () => {
              await invokeSubscription("canvas-scene:unsubscribe", fullRequest);
            },
            finalize: () => {
              if (subscriptions.get(key)?.lifecycle === lifecycle) {
                subscriptions.delete(key);
              }
              removeBridgeListener();
            },
          });
        const createdEntry: ElectronCanvasSubscription = {
          subscribers,
          lifecycle,
        };
        entry = createdEntry;
        subscriptions.set(key, entry);
      }
      const subscriber: ElectronCanvasSubscriber = {
        listener,
        presenceListener,
      };
      entry.subscribers.add(subscriber);
      void ensureRemoteSubscription(entry);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entry?.subscribers.delete(subscriber);
        if (!entry || entry.subscribers.size > 0) return;
        entry.lifecycle.releaseIfIdle();
      };
    },
    async sync(request): Promise<CanvasSceneSyncCommandResult> {
      try {
        if (contentAccessContextKey(request.accessContext) !== accessKey) {
          throw new TypeError("Canvas sync crossed its access boundary");
        }
        const entry = subscriptions.get(
          JSON.stringify([request.documentId, request.clientSessionId]),
        );
        const ready = entry ? await ensureRemoteSubscription(entry) : null;
        if (!ready?.ok) {
          return {
            ok: false,
            error: ready?.error ?? {
              code: "access_scope_mismatch",
              message: "Canvas scene subscription is not active",
              retryable: false,
              resetRequired: false,
            },
          };
        }
        return await invoke("canvas-scene:sync", request);
      } catch (error) {
        return { ok: false, error: transportFailure(error) };
      }
    },
    async applyMutation(request): Promise<CanvasSceneMutationCommandResult> {
      try {
        if (contentAccessContextKey(request.accessContext) !== accessKey) {
          throw new TypeError("Canvas mutation crossed its access boundary");
        }
        const entry = subscriptions.get(
          JSON.stringify([request.documentId, request.clientSessionId]),
        );
        const ready = entry ? await ensureRemoteSubscription(entry) : null;
        if (!ready?.ok) {
          return {
            ok: false,
            error: ready?.error ?? {
              code: "access_scope_mismatch",
              message: "Canvas scene subscription is not active",
              retryable: false,
              resetRequired: false,
              mutationId: request.mutationId,
            },
          };
        }
        return await invokeLocalCommitCommandResultThrough(
          canvasSceneMutationCommand,
          bridge,
          request,
        );
      } catch (error) {
        return { ok: false, error: { ...transportFailure(error), mutationId: request.mutationId } };
      }
    },
    async publishPresence(
      request: CanvasPresencePublishRequest,
    ): Promise<CanvasPresenceCommandResult> {
      try {
        if (contentAccessContextKey(request.accessContext) !== accessKey) {
          throw new TypeError("Canvas presence crossed its access boundary");
        }
        const entry = subscriptions.get(
          JSON.stringify([request.publication.documentId, request.clientSessionId]),
        );
        const ready = entry ? await ensureRemoteSubscription(entry) : null;
        if (!ready?.ok) {
          return {
            ok: false,
            error: {
              code: "unauthorized",
              message: "Canvas scene subscription is not active",
              retryable: false,
              resetRequired: false,
            },
          };
        }
        return await invoke("canvas-scene:presence:publish", request);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "transport_unavailable",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            resetRequired: false,
          },
        };
      }
    },
  };
};
