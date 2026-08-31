import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ContentAccessContext } from "../../../shared/content-access-context";
import { documentSyncApplyCommandResult } from "../../../shared/block-documents/document-sync";
import type { DocumentSyncClientTarget } from "../../document-sync-transport";
import {
  createElectronDocumentSyncAdapter,
  createElectronLibraryDocumentSyncAdapter,
} from "../../../renderer/lib/electron-document-sync-adapter";
import type { ElectronRendererBridge } from "../../../renderer/lib/electron-renderer-transport";
import {
  layer as scopedCallbackRuntimeLayer,
  ScopedCallbackRuntime,
} from "../../app/ScopedCallbackRuntime";
import { CoreAuthority, CoreSessionAccess } from "../../core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../../core-runtime/CoreModules";
import { classifyCoreOperationFailure } from "../../core-runtime/CoreRuntimeError";
import { live as documentLiveRuntimeLive } from "../../core-runtime/DocumentLiveRuntime";
import {
  DesktopDocumentSessionRuntime,
  desktopDocumentSessionRuntimeLive,
} from "../desktop-document-sync-bridge";
import type { CoreGenerationClient } from "../core-generation-client";

class HarnessTarget implements DocumentSyncClientTarget {
  readonly id = 1;
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly destroyedListeners = new Set<() => void>();

  isDestroyed(): boolean {
    return false;
  }

  send(channel: string, ...args: unknown[]): void {
    this.listeners.get(channel)?.forEach((listener) => listener(...args));
  }

  once(event: "destroyed", listener: () => void): void {
    if (event === "destroyed") this.destroyedListeners.add(listener);
  }

  removeListener(event: "destroyed", listener: () => void): void {
    if (event === "destroyed") this.destroyedListeners.delete(listener);
  }
}

const omitProjectScope = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return value;
  const { projectId: _projectId, ...request } = value as Record<string, unknown>;
  return request;
};

/** Integration test support for the real renderer boundary and final Main Effect services. */
export const makeDesktopDocumentSessionHarness = Effect.fn("DesktopDocumentSessionHarness.make")(
  function* (client: CoreGenerationClient, scope: ContentAccessContext) {
    const access = CoreSessionAccess.of({
      handshake: Effect.succeed(client.handshake),
      use: (operation, run, options) =>
        Effect.tryPromise({
          try: (signal) =>
            run(options?.projectId ? client.forProject(options.projectId) : client, signal),
          catch: (cause) =>
            classifyCoreOperationFailure(operation, cause, client.handshake.generation.start_nonce),
        }),
    });
    const accessLayer = Layer.succeed(CoreSessionAccess, access);
    const coreModulesLayer = coreModulesLive.pipe(Layer.provide(accessLayer));
    const coreModulesContext = yield* Layer.build(coreModulesLayer);
    const coreModules = Context.get(coreModulesContext, CoreModules);
    const callbackContext = yield* Layer.build(scopedCallbackRuntimeLayer);
    const callbacks = Context.get(callbackContext, ScopedCallbackRuntime);
    const authority = CoreAuthority.of({
      identity: {
        libraryId: client.handshake.library_id,
        profileId: client.handshake.generation.profile_id,
        storeEpoch: client.handshake.store_epoch,
      },
    } as CoreAuthority["Service"]);
    const dependencies = Layer.mergeAll(
      Layer.succeed(CoreAuthority, authority),
      accessLayer,
      Layer.succeed(CoreModules, coreModules),
      documentLiveRuntimeLive,
    );
    const sessionContext = yield* Layer.build(
      desktopDocumentSessionRuntimeLive().pipe(Layer.provide(dependencies)),
    );
    const session = Context.get(sessionContext, DesktopDocumentSessionRuntime);
    const target = new HarnessTarget();
    const bridge = {
      invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
        const request = omitProjectScope(args[0]);
        switch (channel) {
          case "document-sync:subscribe":
          case "library-document-sync:subscribe":
            return callbacks.runPromise(session.subscribe(scope, target, request as never));
          case "document-sync:unsubscribe":
          case "library-document-sync:unsubscribe":
            return callbacks.runPromise(session.unsubscribe(scope, target, request as never));
          case "document-sync:sync":
          case "library-document-sync:sync":
            return callbacks.runPromise(session.sync(scope, target, request as never));
          case "document-sync:apply":
          case "library-document-sync:apply":
            return callbacks
              .runPromise(session.applyUpdate(scope, target, request as never))
              .then(documentSyncApplyCommandResult);
          case "document-sync:awareness:publish":
          case "library-document-sync:awareness:publish":
            return callbacks.runPromise(session.publishAwareness(scope, target, request as never));
          default:
            return Promise.reject(new Error(`Unexpected Electron harness channel: ${channel}`));
        }
      },
      on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
        const listeners = target.listeners.get(channel) ?? new Set();
        listeners.add(listener);
        target.listeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    } as ElectronRendererBridge;

    return scope.kind === "project"
      ? createElectronDocumentSyncAdapter(bridge, scope.projectId)
      : createElectronLibraryDocumentSyncAdapter(bridge);
  },
);
