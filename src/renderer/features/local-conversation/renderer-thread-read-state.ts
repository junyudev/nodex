import { subscribeCodexEvents } from "./local-conversation-deps";
import type {
  ThreadReadStateChange,
  ThreadReadStateStatus,
  ThreadReadStateEvent,
  ThreadReadStateRpcSession,
  ThreadReadStateRpcService,
} from "../../../shared/codex-thread-read-state";

export interface RendererReadStateManager {
  retireNativeHostContext(): void;
  receiveReadStateSnapshot(unreadIds: readonly string[] | null): void;
  receiveReadStateChange(threadId: string, unread: boolean): void;
}

/** Read-state sessions borrow the window service without replacing or closing its peer. */
export function connectRendererThreadReadState(
  getManager: (hostId: string) => RendererReadStateManager,
  serviceReady: Promise<ThreadReadStateRpcService | undefined>,
): Disposable & {
  set(change: ThreadReadStateChange, origin?: "user" | "turn"): Promise<ThreadReadStateStatus>;
} {
  let disposed = false;
  let current: ThreadReadStateRpcSession | undefined;
  let hosts: string[] = [];
  let hostKeys: Readonly<Record<string, string>> | undefined;
  const pendingWrites = new Map<
    string,
    { change: ThreadReadStateChange; hostKey: string; user?: boolean; turnUnread?: boolean }
  >();
  let opening: Promise<void> | undefined;
  let reopen = false;
  let generation = 0;
  let identityGeneration = 0;
  const release = (session: ThreadReadStateRpcSession | undefined) => {
    if (!session) return;
    void Promise.resolve(session.unsubscribe()).catch(() => {});
    (session as ThreadReadStateRpcSession & Partial<Disposable>)[Symbol.dispose]?.();
  };
  const open = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (opening) return opening;
    opening = runOpen();
    return opening;
  };
  const runOpen = async () => {
    const captured = ++generation;
    try {
      const service = await serviceReady;
      if (!service || disposed) return;
      if (!hostKeys) {
        hostKeys = await service.getExecutionHostKeys();
        hosts = Object.keys(hostKeys);
      }
      if (disposed) return;
      let retired = false;
      let ready = false;
      const pending: Extract<ThreadReadStateEvent, { type: "changed" }>[] = [];
      const result = await service.open((event: ThreadReadStateEvent) => {
        if (disposed || captured !== generation) return;
        if (event.type === "changed") {
          if (!ready) {
            pending.push(event);
            return;
          }
          getManager(event.hostId).receiveReadStateChange(event.threadId, event.hasUnreadTurn);
          return;
        }
        retired = true;
        if (event.reason === "identity" || event.reason === "disposed") {
          identityGeneration += 1;
          pendingWrites.clear();
        }
        release(current);
        current = undefined;
        for (const host of hosts) {
          const manager = getManager(host);
          if (event.reason !== "hosts") manager.retireNativeHostContext();
          manager.receiveReadStateSnapshot(null);
        }
        if (opening) reopen = true;
        else void open();
      });
      if (result.status !== "ready") return;
      if (disposed || retired) {
        release(result.session);
        return;
      }
      ready = true;
      current = result.session;
      for (const host of hosts) {
        if (hostKeys?.[host] !== result.executionHostKeysByHostId[host])
          getManager(host).retireNativeHostContext();
      }
      hostKeys = result.executionHostKeysByHostId;
      hosts = Object.keys(hostKeys);
      for (const host of hosts)
        getManager(host).receiveReadStateSnapshot(result.unreadThreadIdsByHostId[host] ?? []);
      for (const event of pending)
        getManager(event.hostId).receiveReadStateChange(event.threadId, event.hasUnreadTurn);
      for (const [key, pending] of pendingWrites) {
        pendingWrites.delete(key);
        if (hostKeys[pending.change.hostId] !== pending.hostKey) continue;
        getManager(pending.change.hostId).receiveReadStateChange(
          pending.change.threadId,
          pending.change.hasUnreadTurn,
        );
        const status = await result.session.set(pending.change);
        if (status.status !== "ok") {
          release(current);
          current = undefined;
          reopen = true;
          break;
        }
      }
    } catch {
      /* Connection retirement leaves read state unavailable until the next window connection. */
    } finally {
      opening = undefined;
      if (reopen && !disposed) {
        reopen = false;
        if (opening) reopen = true;
        else void open();
      }
    }
  };
  const stopAccount = subscribeCodexEvents((event) => {
    if (event.type === "account" && !current) void open();
  });
  void open();
  return {
    async set(change, origin = "user") {
      const identityAtAdmission = identityGeneration;
      if (disposed) return { status: "retired" };
      if (!current) await open();
      if (disposed || identityAtAdmission !== identityGeneration) return { status: "retired" };
      if (!current) {
        const hostKey = hostKeys?.[change.hostId];
        if (hostKey !== undefined) {
          const key = JSON.stringify([change.hostId, change.threadId]);
          const previous = pendingWrites.get(key);
          const user = origin === "user" ? change.hasUnreadTurn : previous?.user;
          const turnUnread = origin === "turn" ? change.hasUnreadTurn : false;
          if (user === undefined && !turnUnread) pendingWrites.delete(key);
          else
            pendingWrites.set(key, {
              change: { ...change, hasUnreadTurn: Boolean(turnUnread || user) },
              hostKey,
              user,
              turnUnread,
            });
        }
        return { status: "unavailable" };
      }
      const session = current;
      const result = await session.set(change);
      if (result.status !== "ok" && current === session) {
        release(current);
        current = undefined;
        void open();
      }
      return result;
    },
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      stopAccount();
      pendingWrites.clear();
      release(current);
      for (const host of hosts) getManager(host).receiveReadStateSnapshot(null);
    },
  };
}
