import type { ThreadReadStateRpcService } from "../../../shared/codex-thread-read-state";
import { RpcSession, RpcTarget } from "capnweb";
import type {
  ConversationCoordinationHost,
  ConversationCoordinationView,
} from "../../../shared/codex-client-coordination";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "../../../shared/codex-service-port";
import { ConversationServiceRoot } from "../../../shared/codex-service-root";
import { connectCoordinationPeer } from "../node/CodexCoordinationPeer";

/** A window's socket client and service port have the same lifetime as its trusted WebContents. */
export function connectConversationService(
  port: ConversationServicePort,
  getEndpoint: () => Promise<string>,
  onError: (error: unknown) => void,
  readState?: ThreadReadStateRpcService,
): { getClientId(): Promise<string | null>; dispose(): void } {
  const transport = new ConversationServicePortTransport(port);
  let disposed = false;
  let peer: ReturnType<typeof connectCoordinationPeer> | undefined;
  const coordination = Promise.resolve()
    .then(() => root.services)
    .then((services) => {
      if (disposed || !services.clientCoordination) return undefined;
      peer = connectCoordinationPeer(getEndpoint, () => services.clientCoordination!, onError);
      return peer.host;
    });
  void coordination.catch(onError);
  class DeferredCoordination extends RpcTarget implements ConversationCoordinationHost {
    threadArchived(
      input: Parameters<ConversationCoordinationHost["threadArchived"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadArchived"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadArchived(input);
      });
    }
    threadUnarchived(
      input: Parameters<ConversationCoordinationHost["threadUnarchived"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadUnarchived"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadUnarchived(input);
      });
    }
    threadQueuedFollowUpsChanged(
      input: Parameters<ConversationCoordinationHost["threadQueuedFollowUpsChanged"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadQueuedFollowUpsChanged"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadQueuedFollowUpsChanged(input);
      });
    }
    setThreadOwnership(
      input: Parameters<ConversationCoordinationHost["setThreadOwnership"]>[0],
    ): ReturnType<ConversationCoordinationHost["setThreadOwnership"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.setThreadOwnership(input);
      });
    }
    threadStreamStateChanged(
      input: Parameters<ConversationCoordinationHost["threadStreamStateChanged"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadStreamStateChanged"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadStreamStateChanged(input);
      });
    }
    threadStreamFollowingChanged(
      input: Parameters<ConversationCoordinationHost["threadStreamFollowingChanged"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadStreamFollowingChanged"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadStreamFollowingChanged(input);
      });
    }
    threadStreamFollowingStatusRequested(
      input: Parameters<ConversationCoordinationHost["threadStreamFollowingStatusRequested"]>[0],
    ): ReturnType<ConversationCoordinationHost["threadStreamFollowingStatusRequested"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.threadStreamFollowingStatusRequested(input);
      });
    }
    findThreadOwner(
      input: Parameters<ConversationCoordinationHost["findThreadOwner"]>[0],
    ): ReturnType<ConversationCoordinationHost["findThreadOwner"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.findThreadOwner(input);
      });
    }
    requestThreadFollower(
      input: Parameters<ConversationCoordinationHost["requestThreadFollower"]>[0],
    ): ReturnType<ConversationCoordinationHost["requestThreadFollower"]> {
      return coordination.then((host) => {
        if (!host) throw new Error("Window coordination is unavailable");
        return host.requestThreadFollower(input);
      });
    }
  }
  const root = new RpcSession<ConversationServiceRoot<ConversationCoordinationView | undefined>>(
    transport,
    new ConversationServiceRoot(new DeferredCoordination(), readState),
  ).getRemoteMain();
  return {
    getClientId: () =>
      coordination.then(() =>
        disposed || !peer ? null : peer.getClientId().then((id) => (disposed ? null : id)),
      ),
    dispose: () => {
      disposed = true;
      peer?.dispose();
      transport.abort(new Error("Conversation service was disposed"));
    },
  };
}
