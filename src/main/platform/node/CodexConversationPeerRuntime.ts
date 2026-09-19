import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { acquireCodexPeerEndpointManager } from "./CodexPeerEndpoint";

/** All application peers share one Profile socket endpoint and its shutdown boundary. */
export class CodexConversationPeerRuntime extends Context.Service<
  CodexConversationPeerRuntime,
  {
    readonly getEndpoint: () => Promise<string>;
    readonly registerWindowPeer: (
      senderId: number,
      getClientId: () => Promise<string | null>,
    ) => () => void;
    readonly resolvePeerClientId: (senderId: number) => Promise<string | null>;
  }
>()("nodex/main/platform/node/CodexConversationPeerRuntime") {}

export const live = Layer.effect(
  CodexConversationPeerRuntime,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const callbacks = yield* ScopedCallbackRuntime;
    const endpoints = yield* acquireCodexPeerEndpointManager(config.nodexHome, (cause) => {
      callbacks.fork(
        Effect.logWarning("Conversation peer endpoint failed").pipe(Effect.annotateLogs({ cause })),
      );
    });
    const windowPeers = new Map<number, () => Promise<string | null>>();
    yield* Effect.addFinalizer(() => Effect.sync(() => windowPeers.clear()));
    return CodexConversationPeerRuntime.of({
      registerWindowPeer: (senderId, getClientId) => {
        windowPeers.set(senderId, getClientId);
        return () => {
          if (windowPeers.get(senderId) === getClientId) windowPeers.delete(senderId);
        };
      },
      resolvePeerClientId: (senderId) => {
        const resolve = windowPeers.get(senderId);
        if (!resolve) return Promise.resolve(null);
        return resolve().then((id) => (windowPeers.get(senderId) === resolve ? id : null));
      },
      getEndpoint: () => endpoints.getOrStartRouterEndpoint(),
    });
  }),
);
