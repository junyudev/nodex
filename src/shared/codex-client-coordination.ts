import type { CodexPeerResponse } from "./codex-peer-protocol";

export const CODEX_CONVERSATION_SERVICE_CHANNEL = "codex:conversation-service:connect";
export const CODEX_CONVERSATION_SERVICE_CONNECT = "connect-conversation-host";

export interface ConversationCoordinationParams {
  hostId: string;
  conversationId: string;
}

export interface ConversationCoordinationEvent<Params = unknown> {
  sourceClientId: string;
  params: Params;
}

export interface ConversationFollowerRequest {
  method: string;
  params: unknown;
}

export interface ConversationCoordinationView {
  threadArchived(event: ConversationCoordinationEvent): void;
  threadUnarchived(event: ConversationCoordinationEvent): void;
  threadQueuedFollowUpsChanged(event: ConversationCoordinationEvent): void;

  clientStatusChanged(event: ConversationCoordinationEvent): void;
  ipcConnectionReset(event: ConversationCoordinationEvent): void;
  threadStreamStateChanged(event: ConversationCoordinationEvent): void;
  threadStreamFollowingChanged(event: ConversationCoordinationEvent): void;
  threadStreamFollowingStatusRequested(event: ConversationCoordinationEvent): void;
  getThreadRole(params: ConversationCoordinationParams): Promise<"owner" | "follower">;
  requestThreadFollower(input: {
    hostId: string;
    request: ConversationFollowerRequest;
  }): Promise<{ method: string; result: unknown }>;
}

export interface ConversationCoordinationHost {
  threadArchived(params: unknown): Promise<void>;
  threadUnarchived(params: unknown): Promise<void>;
  threadQueuedFollowUpsChanged(params: unknown): Promise<void>;

  setThreadOwnership(
    input: ConversationCoordinationParams & { ownsThread: boolean },
  ): Promise<void>;
  threadStreamStateChanged(input: {
    params: ConversationCoordinationParams & { change: unknown };
    targetClientIds?: readonly string[];
  }): Promise<void>;
  threadStreamFollowingChanged(input: {
    params: ConversationCoordinationParams & { following: boolean };
    targetClientIds?: readonly string[];
  }): Promise<void>;
  threadStreamFollowingStatusRequested(params: ConversationCoordinationParams): Promise<void>;
  findThreadOwner(params: ConversationCoordinationParams): Promise<string | null>;
  requestThreadFollower(input: {
    hostId: string;
    request: ConversationFollowerRequest;
    targetClientId?: string;
    timeoutMs?: number;
  }): Promise<CodexPeerResponse>;
}
