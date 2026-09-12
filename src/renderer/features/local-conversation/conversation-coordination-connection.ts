import type { ThreadReadStateRpcService } from "../../../shared/codex-thread-read-state";
import { RpcSession } from "capnweb";
import {
  CODEX_CONVERSATION_SERVICE_CONNECT,
  type ConversationCoordinationEvent,
  type ConversationCoordinationHost,
} from "../../../shared/codex-client-coordination";
import {
  ConversationCoordinationViewTarget,
  type ConversationCoordinationBroadcast,
  type ConversationCoordinationManager,
} from "../../../shared/codex-coordination-view";
import { ConversationServicePortTransport } from "../../../shared/codex-service-port";
import { ConversationServiceRoot } from "../../../shared/codex-service-root";

export interface ConversationCoordinationConnection extends Disposable {
  readonly ready: Promise<ConversationCoordinationHost>;
  readonly readStateReady: Promise<ThreadReadStateRpcService | undefined>;
}

/** One window service is shared by its host managers; it never stores conversation state. */
export function connectConversationCoordination(
  getManager: ((hostId: string) => ConversationCoordinationManager) | undefined,
  broadcast: (
    method: ConversationCoordinationBroadcast,
    event: ConversationCoordinationEvent,
  ) => void,
): ConversationCoordinationConnection {
  const { port1, port2 } = new MessageChannel();
  const transport = new ConversationServicePortTransport({
    start: () => port1.start(),
    postMessage: (message) => {
      port1.postMessage(message);
    },
    close: () => port1.close(),
    on: (event, listener) => {
      if (event === "message") port1.addEventListener("message", listener);
      else port1.addEventListener("messageerror", listener as () => void);
    },
  });
  let disposed = false;
  let failure: unknown;
  const assertActive = () => {
    if (disposed) throw new Error("Conversation coordination connection disposed");
  };
  const root = new RpcSession<ConversationServiceRoot<ConversationCoordinationHost>>(
    transport,
    new ConversationServiceRoot(
      getManager
        ? new ConversationCoordinationViewTarget(
            (hostId) => {
              assertActive();
              return getManager(hostId);
            },
            (method, event) => {
              assertActive();
              broadcast(method, event);
            },
          )
        : undefined,
    ),
  ).getRemoteMain();
  const ready = (async () => {
    const services = await root.services.catch((error: unknown) => {
      throw failure ?? error;
    });
    assertActive();
    return services.clientCoordination;
  })();
  const readStateReady = (async () => {
    const services = await root.services;
    assertActive();
    return services.threadReadState;
  })();
  void readStateReady.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    failure ??= new Error("Conversation coordination connection disposed");
    transport.abort(failure);
    root[Symbol.dispose]();
    port2.close();
  };
  // A caller can dispose its scope before it has installed a readiness handler.
  void ready.catch(() => {});
  try {
    window.postMessage(
      { type: CODEX_CONVERSATION_SERVICE_CONNECT, port: port2 },
      window.location.origin,
      [port2],
    );
  } catch (error) {
    failure = error;
    dispose();
  }
  return { ready, readStateReady, [Symbol.dispose]: dispose };
}
