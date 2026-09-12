import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { CodexThreadReadState } from "../../codex-application/CodexThreadReadState";
import { CodexThreadReadStateService } from "../../platform/electron/CodexThreadReadStateService";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WebContents } from "electron";
import { CODEX_CONVERSATION_SERVICE_CHANNEL } from "../../../shared/codex-client-coordination";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { connectConversationService } from "../../platform/electron/CodexConversationService";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { CodexConversationPeerRuntime } from "../../platform/node/CodexConversationPeerRuntime";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

interface WindowService {
  readonly sender: WebContents;
  readonly dispose: () => void;
}

/** A transferred port creates one independent socket peer for the trusted window. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const callbacks = yield* ScopedCallbackRuntime;
    const peers = yield* CodexConversationPeerRuntime;
    const readState = yield* CodexThreadReadState;
    const scope = yield* Scope.Scope;
    const report = (cause: unknown): void => {
      callbacks.fork(
        Effect.logWarning("Conversation peer transport failed").pipe(
          Effect.annotateLogs({ cause }),
        ),
      );
    };
    const services = new Map<number, WindowService>();
    const release = (senderId: number): void => {
      const service = services.get(senderId);
      if (!service) return;
      services.delete(senderId);
      service.sender.removeListener("destroyed", service.dispose);
      service.dispose();
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of services.keys()) release(id);
      }),
    );
    yield* ipc.on(CODEX_CONVERSATION_SERVICE_CHANNEL, (event) =>
      Effect.gen(function* () {
        yield* Effect.try(() => {
          requireTrustedAppRendererSender(event, "Conversation service", config.rendererUrl);
          if (!windows.has(event.sender.id))
            throw new Error("Conversation service requires an active Nodex window");
          if (event.ports.length !== 1)
            throw new Error("Conversation service requires one transferred port");
        });
        const port = event.ports[0];
        if (!port) return;
        release(event.sender.id);
        const windowScope = yield* Scope.fork(scope, "sequential");
        yield* Effect.try(() => {
          const connection = connectConversationService(
            port,
            peers.getEndpoint,
            report,
            new CodexThreadReadStateService(readState, callbacks, windowScope),
          );
          const unregisterPeer = peers.registerWindowPeer(event.sender.id, connection.getClientId);
          const dispose = (): void => {
            unregisterPeer();
            if (services.get(event.sender.id)?.dispose === dispose)
              services.delete(event.sender.id);
            event.sender.removeListener("destroyed", dispose);
            port.removeListener("close", dispose);
            connection.dispose();
            callbacks.fork(Scope.close(windowScope, Exit.void));
          };
          services.set(event.sender.id, { sender: event.sender, dispose });
          event.sender.once("destroyed", dispose);
          port.once("close", dispose);
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            for (const port of event.ports) port.close();
            report(error.cause);
          }),
        ),
      ),
    );
  }),
);
