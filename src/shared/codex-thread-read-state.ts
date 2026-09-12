export type ThreadReadStateIdentity =
  | { readonly kind: "chatgpt"; readonly accountId: string; readonly userId: string }
  | { readonly kind: "execution-storage"; readonly authMode: string };

export interface ThreadReadStateChange {
  readonly hostId: string;
  readonly threadId: string;
  readonly hasUnreadTurn: boolean;
}

export type ThreadReadStateEvent =
  | ({ readonly type: "changed"; readonly origin: "self" | "external" } & ThreadReadStateChange)
  | {
      readonly type: "retired";
      readonly reason: "identity" | "hosts" | "unavailable" | "disposed";
    };

export type ThreadReadStateStatus = { readonly status: "ok" | "retired" | "unavailable" };

export interface ThreadReadStateRpcSession {
  set(change: ThreadReadStateChange): Promise<ThreadReadStateStatus>;
  clearForLogout(): Promise<ThreadReadStateStatus>;
  unsubscribe(): void;
}

export type ThreadReadStateRpcOpenResult =
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly identity: ThreadReadStateIdentity;
      readonly executionHostKeysByHostId: Readonly<Record<string, string>>;
      readonly unreadThreadIdsByHostId: Readonly<Record<string, readonly string[]>>;
      readonly session: ThreadReadStateRpcSession;
    };

export interface ThreadReadStateRpcService {
  getExecutionHostKeys(): Promise<Readonly<Record<string, string>>>;
  open(listener: (event: ThreadReadStateEvent) => void): Promise<ThreadReadStateRpcOpenResult>;
}

export interface ThreadReadStateContext {
  readonly identity: ThreadReadStateIdentity;
  readonly executionHostKey: string;
}
export interface ContextualThreadReadStateChange extends ThreadReadStateChange {
  readonly context: ThreadReadStateContext;
}
