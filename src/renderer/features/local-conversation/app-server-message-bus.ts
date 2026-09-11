import type {
  CodexConnectionState,
  CodexHostMessage,
  CodexMcpNotificationMessage,
  CodexSharedObject,
  CodexThreadOwnerNotification,
  CodexThreadOwnerServerRequest,
  CodexThreadStreamStateChange,
} from "../../lib/types";
import type { CodexThreadStreamCheckpoint } from "../../../shared/types";

type AppServerMessageListener<T> = (event: T) => void;

export interface CodexSharedObjectUpdatedEvent {
  hostId: string;
  object: CodexSharedObject;
}

export interface CodexThreadStreamStateChangedEvent {
  hostId: string;
  conversationId: string;
  change: CodexThreadStreamStateChange;
  version: number;
  sourceClientId?: string | null;
  checkpoint: CodexThreadStreamCheckpoint;
  baseCheckpoint: CodexThreadStreamCheckpoint | null;
}

export interface CodexThreadStreamFollowingStatusRequestedEvent {
  hostId: string;
  conversationId: string;
  ownerClientId: string;
}

export interface CodexThreadStreamFollowersChangedEvent {
  hostId: string;
  conversationId: string;
  ownerClientId: string;
  followerClientIds: string[];
  membershipEpoch: number;
}

export type CodexThreadStreamSnapshotRequestedEvent = Omit<
  Extract<CodexHostMessage, { type: "threadStreamSnapshotRequested" }>,
  "type"
>;

export interface CodexThreadStreamTransportResetEvent {
  hostId: string;
  conversationIds: string[];
}

export interface CodexClientStatusChangedEvent {
  hostId: string;
  status: CodexConnectionState["status"];
}

export interface CodexThreadTitleUpdatedEvent {
  hostId: string;
  conversationId: string;
  title: string;
}

export interface CodexThreadReadStateChangedEvent {
  hostId: string;
  conversationId: string;
  hasUnreadTurn: boolean;
}

export interface CodexThreadArchivedEvent {
  hostId: string;
  conversationId: string;
}

export interface CodexThreadDeletedEvent {
  hostId: string;
  threadId: string;
}

export interface CodexErrorEvent {
  hostId: string;
  message: string;
  detail?: string;
}

export type CodexMcpNotificationEvent = Omit<CodexMcpNotificationMessage, "type">;

export interface CodexThreadOwnerNotificationEvent {
  hostId: string;
  sequence: number;
  notification: CodexThreadOwnerNotification;
}

export interface CodexThreadOwnerRequestEvent {
  hostId: string;
  request: CodexThreadOwnerServerRequest;
  sequence: number;
}

export interface CodexThreadOwnerUnavailableEvent {
  hostId: string;
  ownerClientId: string;
  conversationIds: string[];
}

interface CodexAppServerMessageMap {
  "shared-object-updated": CodexSharedObjectUpdatedEvent;
  "thread-stream-state-changed": CodexThreadStreamStateChangedEvent;
  "thread-stream-following-status-requested": CodexThreadStreamFollowingStatusRequestedEvent;
  "thread-stream-followers-changed": CodexThreadStreamFollowersChangedEvent;
  "thread-stream-snapshot-requested": CodexThreadStreamSnapshotRequestedEvent;
  "thread-stream-transport-reset": CodexThreadStreamTransportResetEvent;
  "client-status-changed": CodexClientStatusChangedEvent;
  "thread-title-updated": CodexThreadTitleUpdatedEvent;
  "thread-read-state-changed": CodexThreadReadStateChangedEvent;
  "thread-archived": CodexThreadArchivedEvent;
  "thread-deleted": CodexThreadDeletedEvent;
  "thread-owner-notification": CodexThreadOwnerNotificationEvent;
  "thread-owner-request": CodexThreadOwnerRequestEvent;
  "thread-owner-unavailable": CodexThreadOwnerUnavailableEvent;
  "mcp-notification": CodexMcpNotificationEvent;
  error: CodexErrorEvent;
}

const listenersByType: {
  [K in keyof CodexAppServerMessageMap]: Set<AppServerMessageListener<CodexAppServerMessageMap[K]>>;
} = {
  "shared-object-updated": new Set(),
  "thread-stream-state-changed": new Set(),
  "thread-stream-following-status-requested": new Set(),
  "thread-stream-followers-changed": new Set(),
  "thread-stream-snapshot-requested": new Set(),
  "thread-stream-transport-reset": new Set(),
  "client-status-changed": new Set(),
  "thread-title-updated": new Set(),
  "thread-read-state-changed": new Set(),
  "thread-archived": new Set(),
  "thread-deleted": new Set(),
  "thread-owner-notification": new Set(),
  "thread-owner-request": new Set(),
  "thread-owner-unavailable": new Set(),
  "mcp-notification": new Set(),
  error: new Set(),
};

export function subscribeCodexAppServerMessage<K extends keyof CodexAppServerMessageMap>(
  type: K,
  listener: AppServerMessageListener<CodexAppServerMessageMap[K]>,
): () => void {
  listenersByType[type].add(listener);
  return () => {
    listenersByType[type].delete(listener);
  };
}

export function dispatchCodexAppServerMessage<K extends keyof CodexAppServerMessageMap>(
  type: K,
  event: CodexAppServerMessageMap[K],
): void {
  for (const listener of listenersByType[type]) {
    listener(event);
  }
}

export function __resetCodexAppServerMessageBusForTests(): void {
  for (const listeners of Object.values(listenersByType)) {
    listeners.clear();
  }
}
