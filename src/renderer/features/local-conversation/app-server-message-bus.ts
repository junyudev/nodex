import type {
  CodexConnectionState,
  CodexMcpNotificationMessage,
  CodexSharedObject,
} from "../../lib/types";
import type {
  CodexNativeNotificationMessage,
  CodexNativeRequestMessage,
} from "../../../shared/types";

type AppServerMessageListener<T> = (event: T) => void;

export interface CodexSharedObjectUpdatedEvent {
  hostId: string;
  object: CodexSharedObject;
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

interface CodexAppServerMessageMap {
  "shared-object-updated": CodexSharedObjectUpdatedEvent;
  "client-status-changed": CodexClientStatusChangedEvent;
  "thread-title-updated": CodexThreadTitleUpdatedEvent;
  "thread-read-state-changed": CodexThreadReadStateChangedEvent;
  "thread-archived": CodexThreadArchivedEvent;
  "thread-deleted": CodexThreadDeletedEvent;
  "native-notification": CodexNativeNotificationMessage;
  "native-request": CodexNativeRequestMessage;
  "mcp-response": import("../../../shared/codex-native-request-outcome").CodexNativeResponseMessage;
  "mcp-request-delivery": import("../../../shared/codex-native-request-outcome").CodexNativeDeliveryMessage;
  "mcp-notification": CodexMcpNotificationEvent;
  error: CodexErrorEvent;
}

const listenersByType: {
  [K in keyof CodexAppServerMessageMap]: Set<AppServerMessageListener<CodexAppServerMessageMap[K]>>;
} = {
  "shared-object-updated": new Set(),
  "client-status-changed": new Set(),
  "thread-title-updated": new Set(),
  "thread-read-state-changed": new Set(),
  "thread-archived": new Set(),
  "thread-deleted": new Set(),
  "native-notification": new Set(),
  "native-request": new Set(),
  "mcp-response": new Set(),
  "mcp-request-delivery": new Set(),
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
