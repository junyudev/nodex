/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/global-date, effecttsgo/new-promise -- Socket service callbacks bridge scoped managers and RPC calls with elapsed-time deadlines. */
import { RpcTarget } from "capnweb";
import type {
  ConversationCoordinationHost,
  ConversationCoordinationParams,
  ConversationCoordinationView,
} from "../../../shared/codex-client-coordination";
import {
  CODEX_PEER_METHOD_VERSIONS,
  codexPeerMethodVersion,
  type CodexPeerBroadcast,
} from "../../../shared/codex-peer-protocol";
import { CodexPeerClient } from "./CodexPeerClient";

type CoordinationPeerView = {
  [Method in keyof ConversationCoordinationView]: (
    ...args: Parameters<ConversationCoordinationView[Method]>
  ) =>
    | PromiseLike<Awaited<ReturnType<ConversationCoordinationView[Method]>>>
    | Awaited<ReturnType<ConversationCoordinationView[Method]>>;
};

class CoordinationHost extends RpcTarget implements ConversationCoordinationHost {
  private readonly ownedThreads = new Set<string>();

  constructor(private readonly peer: CodexPeerClient) {
    super();
  }

  ownsThread({ hostId, conversationId }: ConversationCoordinationParams): boolean {
    return this.ownedThreads.has(`${hostId}:${conversationId}`);
  }

  async setThreadOwnership(
    input: ConversationCoordinationParams & { ownsThread: boolean },
  ): Promise<void> {
    const key = `${input.hostId}:${input.conversationId}`;
    if (input.ownsThread) this.ownedThreads.add(key);
    else this.ownedThreads.delete(key);
  }

  async threadArchived(params: unknown): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-archived", params);
  }

  async threadUnarchived(params: unknown): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-unarchived", params);
  }

  async threadQueuedFollowUpsChanged(params: unknown): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-queued-followups-changed", params);
  }

  async threadStreamStateChanged(
    input: Parameters<ConversationCoordinationHost["threadStreamStateChanged"]>[0],
  ): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-stream-state-changed", input.params, {
      targetClientIds: input.targetClientIds,
    });
  }

  async threadStreamFollowingChanged(
    input: Parameters<ConversationCoordinationHost["threadStreamFollowingChanged"]>[0],
  ): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-stream-following-changed", input.params, {
      targetClientIds: input.targetClientIds,
    });
  }

  async threadStreamFollowingStatusRequested(
    params: ConversationCoordinationParams,
  ): Promise<void> {
    await this.peer.waitUntilInitialized({ timeoutMs: 5_000 });
    await this.peer.sendBroadcast("thread-stream-following-status-requested", params);
  }

  async findThreadOwner(params: ConversationCoordinationParams): Promise<string | null> {
    const timeoutMs = await this.initializationBudget();
    const response = await this.peer.sendRequest("thread-owner-discovery", params, { timeoutMs });
    if (response.resultType === "success") return response.handledByClientId;
    if (response.error === "no-client-found") return null;
    throw new Error(response.error);
  }

  async requestThreadFollower(
    input: Parameters<ConversationCoordinationHost["requestThreadFollower"]>[0],
  ) {
    const timeoutMs = await this.initializationBudget(input.timeoutMs);
    const { method, params } = input.request;
    if (method === "thread-follower-start-turn" && hasUntrustedAppInput(params)) {
      const response = await this.peer
        .sendRequest(
          "thread-owner-discovery",
          {
            hostId: input.hostId,
            conversationId: params.conversationId,
          },
          { targetClientId: input.targetClientId, timeoutMs },
        )
        .catch(() => null);
      if (
        response?.resultType !== "success" ||
        response.handledByClientId !== input.targetClientId ||
        !supportsUntrustedAppInput(response.result)
      ) {
        throw new Error("App input requires confirmation before legacy delivery");
      }
    }
    return this.peer.sendRequest(method, params, {
      hostId: input.hostId === "local" ? undefined : input.hostId,
      targetClientId: input.targetClientId,
      timeoutMs,
    });
  }

  private async initializationBudget(timeoutMs = 5_000): Promise<number> {
    const started = Date.now();
    await this.peer.waitUntilInitialized({ timeoutMs });
    return Math.max(0, timeoutMs - (Date.now() - started));
  }
}

function hasUntrustedAppInput(params: unknown): params is { conversationId: string } {
  if (params === null || typeof params !== "object") return false;
  const turnStart: unknown = Reflect.get(params, "turnStart");
  if (turnStart === null || typeof turnStart !== "object") return false;
  const context: unknown = Reflect.get(turnStart, "context");
  if (context === null || typeof context !== "object") return false;
  const items: unknown = Reflect.get(context, "responseItems");
  return Array.isArray(items) && items.length > 0;
}

function supportsUntrustedAppInput(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    Reflect.get(result, "supportsUntrustedAppInput") === true
  );
}

async function deliverBroadcast(
  view: CoordinationPeerView,
  event: CodexPeerBroadcast,
): Promise<void> {
  if (event.version !== codexPeerMethodVersion(event.method)) return;
  const value = { sourceClientId: event.sourceClientId, params: event.params };
  switch (event.method) {
    case "thread-archived":
      await view.threadArchived(value);
      return;
    case "thread-unarchived":
      await view.threadUnarchived(value);
      return;
    case "thread-queued-followups-changed":
      await view.threadQueuedFollowUpsChanged(value);
      return;

    case "client-status-changed":
      await view.clientStatusChanged(value);
      return;
    case "ipc-connection-reset":
      await view.ipcConnectionReset(value);
      return;
    case "thread-stream-state-changed":
      await view.threadStreamStateChanged(value);
      return;
    case "thread-stream-following-changed":
      await view.threadStreamFollowingChanged(value);
      return;
    case "thread-stream-following-status-requested":
      await view.threadStreamFollowingStatusRequested(value);
      return;
  }
}

/** Direct managers and window RPC views participate through the same ordinary socket peer. */
export function connectCoordinationPeer(
  getEndpoint: () => Promise<string>,
  getView: () => CoordinationPeerView,
  onError: (error: unknown) => void,
): { host: ConversationCoordinationHost; getClientId(): Promise<string>; dispose(): void } {
  const peer = new CodexPeerClient(getEndpoint, onError);
  const host = new CoordinationHost(peer);
  const detach = peer.addAnyBroadcastHandler((event) => deliverBroadcast(getView(), event));
  peer.addRequestHandler(
    "thread-owner-discovery",
    async (params) => {
      const target = params as ConversationCoordinationParams;
      return (
        target.hostId === "local" &&
        (host.ownsThread(target) ||
          (await withServiceDeadline(
            getView().getThreadRole(target),
            100,
            "thread-role-timeout",
          )) === "owner")
      );
    },
    () => ({ supportsUntrustedAppInput: true }),
  );
  for (const method of Object.keys(CODEX_PEER_METHOD_VERSIONS)) {
    if (!method.startsWith("thread-follower-")) continue;
    peer.addRequestHandler(
      method,
      async (params, request) => {
        const target = params as { conversationId: string };
        return (
          (await withServiceDeadline(
            getView().getThreadRole({
              hostId: request.hostId ?? "local",
              conversationId: target.conversationId,
            }),
            5_000,
            "thread-role-timeout",
          )) === "owner"
        );
      },
      async (request) => {
        const response = await readServiceResponse(
          getView().requestThreadFollower({
            hostId: request.hostId ?? "local",
            request: { method, params: request.params },
          }),
          method === "thread-follower-load-complete-history" ? 300_000 : 5_000,
          `${method}-timeout`,
        );
        if (response.method !== method) throw new Error("thread-follower-response-method-mismatch");
        return response.result;
      },
    );
  }
  return {
    host,
    getClientId: async () => { await peer.waitUntilInitialized(); return peer.getClientId(); },
    dispose: () => {
      detach();
      peer.dispose();
    },
  };
}
async function readServiceResponse<Value extends object>(
  pending:
    | (Value & Partial<Disposable>)
    | (PromiseLike<Value & Partial<Disposable>> & Partial<Disposable>),
  timeoutMs: number,
  message: string,
): Promise<Value> {
  const response = await withServiceDeadline(pending, timeoutMs, message);
  try {
    const result = { ...response };
    delete result[Symbol.dispose];
    return result;
  } finally {
    response[Symbol.dispose]?.();
  }
}

async function withServiceDeadline<Value>(
  response: Value | (PromiseLike<Value> & Partial<Disposable>),
  timeoutMs: number,
  message: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([response, timeout]);
  } finally {
    clearTimeout(timer);
    if (
      expired &&
      response !== null &&
      typeof response === "object" &&
      Symbol.dispose in response
    ) {
      const dispose = response[Symbol.dispose];
      if (typeof dispose === "function") dispose.call(response);
    }
  }
}
