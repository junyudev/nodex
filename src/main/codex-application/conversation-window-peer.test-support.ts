import { MessageChannel } from "node:worker_threads";
import { RpcSession } from "capnweb";
import { applyPatches, type Patch } from "immer";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { ConversationCoordinationHost } from "../../shared/codex-client-coordination";
import { ConversationCoordinationViewTarget } from "../../shared/codex-coordination-view";
import { ConversationStream } from "../../shared/codex-conversation-stream";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "../../shared/codex-service-port";
import { ConversationServiceRoot } from "../../shared/codex-service-root";
import { createConversationStreamServiceTransport } from "../../shared/codex-stream-service-transport";
import { receiveConversationStreamServiceEvent } from "../../shared/codex-stream-service-events";
import { connectConversationService } from "../platform/electron/CodexConversationService";

/** Disposable physical peer used only by the manager integration fixture. */
export function conversationWindowPeer(endpoint: string) {
  const documents = new Map<string, CodexCanonicalConversationState>();
  const failures: unknown[] = [];
  const { port1, port2 } = new MessageChannel();
  const adapt = (port: MessageChannel["port1"]): ConversationServicePort => ({
    start: () => port.start(),
    postMessage: (value) => port.postMessage(value),
    close: () => port.close(),
    on: (event, listener) =>
      event === "message"
        ? port.on("message", (data: unknown) => listener({ data }))
        : port.on("close", listener),
  });
  const view = new ConversationCoordinationViewTarget(
    () => ({
      getStreamRole: (id) => stream.getRole(id),
      handleThreadFollowerRequest: () => Promise.reject(new Error("No follower command expected")),
    }),
    (method, event) => receiveConversationStreamServiceEvent(stream, "local", method, event),
  );
  const transport = new ConversationServicePortTransport(adapt(port2));
  const session = new RpcSession<ConversationServiceRoot<ConversationCoordinationHost>>(
    transport,
    new ConversationServiceRoot(view),
  );
  const service = connectConversationService(
    adapt(port1),
    () => Promise.resolve(endpoint),
    (error) => failures.push(error),
  );
  const host = session.getRemoteMain().services.clientCoordination;
  const stream = new ConversationStream<CodexCanonicalConversationState, Patch>({
    hostId: "local",
    isLocalHost: true,
    canHandleOwnerlessDynamicTool: () => false,
    transport: createConversationStreamServiceTransport(host),
    getConversation: (id) => documents.get(id),
    normalizeSnapshot: (document) => document,
    applyPatches: (document, patches) => applyPatches(document, [...patches]),
    setConversation: (document) => {
      documents.set(document.id, document);
    },
    notifyConversation: () => {},
    onRoleChanged: () => {},
    onFollowersChanged: () => {},
    onOwnerUnavailable: () => {},
    onError: (_operation, _id, error) => {
      failures.push(error);
    },
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  return {
    stream,
    documents,
    failures,
    host,
    getClientId: service.getClientId,
    dispose: () => {
      stream.dispose();
      service.dispose();
      transport.abort(new Error("Window fixture disposed"));
    },
  };
}
