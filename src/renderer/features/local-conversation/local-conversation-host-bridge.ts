import type { CodexHostMessage } from "../../lib/types";
import { dispatchCodexAppServerMessage } from "./app-server-message-bus";
import { subscribeCodexHostMessages } from "./local-conversation-deps";

let bridgeRefCount = 0;
let unsubscribeHostMessages: (() => void) | null = null;

function applyHostMessage(message: CodexHostMessage): void {
  if (message.type === "sharedObjectUpdated") {
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: message.hostId,
      object: message.object,
    });

    if (message.object.objectType === "connection") {
      dispatchCodexAppServerMessage("client-status-changed", {
        hostId: message.hostId,
        status: message.object.value.status,
      });
    }
    return;
  }

  if (message.type === "threadStreamStateChanged") {
    dispatchCodexAppServerMessage("thread-stream-state-changed", {
      hostId: message.hostId,
      conversationId: message.conversationId,
      change: message.change,
      version: message.version,
      sourceClientId: message.sourceClientId ?? null,
      checkpoint: message.checkpoint,
      baseCheckpoint: message.baseCheckpoint ?? null,
    });
    return;
  }

  if (message.type === "threadStreamFollowingStatusRequested") {
    dispatchCodexAppServerMessage("thread-stream-following-status-requested", {
      hostId: message.hostId,
      conversationId: message.conversationId,
      ownerClientId: message.ownerClientId,
    });
    return;
  }

  if (message.type === "threadStreamFollowersChanged") {
    dispatchCodexAppServerMessage("thread-stream-followers-changed", {
      hostId: message.hostId,
      conversationId: message.conversationId,
      ownerClientId: message.ownerClientId,
      followerClientIds: message.followerClientIds,
      membershipEpoch: message.membershipEpoch,
    });
    return;
  }

  if (message.type === "threadStreamSnapshotRequested") {
    dispatchCodexAppServerMessage("thread-stream-snapshot-requested", message);
    return;
  }

  if (message.type === "threadStreamTransportReset") {
    dispatchCodexAppServerMessage("thread-stream-transport-reset", {
      hostId: message.hostId,
      conversationIds: message.conversationIds,
    });
    return;
  }

  if (message.type === "threadOwnerNotification") {
    dispatchCodexAppServerMessage("thread-owner-notification", {
      hostId: message.hostId,
      sequence: message.sequence,
      notification: message.notification,
    });
    return;
  }

  if (message.type === "threadOwnerRequest") {
    dispatchCodexAppServerMessage("thread-owner-request", {
      hostId: message.hostId,
      request: message.request,
      sequence: message.sequence,
    });
    return;
  }

  if (message.type === "threadOwnerUnavailable") {
    dispatchCodexAppServerMessage("thread-owner-unavailable", {
      hostId: message.hostId,
      ownerClientId: message.ownerClientId,
      conversationIds: message.conversationIds,
    });
    return;
  }

  if (message.type === "threadTitleUpdated") {
    dispatchCodexAppServerMessage("thread-title-updated", {
      hostId: message.hostId,
      conversationId: message.conversationId,
      title: message.title,
    });
    return;
  }

  if (message.type === "threadReadStateChanged") {
    dispatchCodexAppServerMessage("thread-read-state-changed", {
      hostId: message.hostId,
      conversationId: message.conversationId,
      hasUnreadTurn: message.hasUnreadTurn,
    });
    return;
  }

  if (message.type === "threadArchived") {
    dispatchCodexAppServerMessage("thread-archived", {
      hostId: message.hostId,
      conversationId: message.conversationId,
    });
    return;
  }

  if (message.type === "threadDeleted") {
    dispatchCodexAppServerMessage("thread-deleted", {
      hostId: message.hostId,
      threadId: message.threadId,
    });
    return;
  }

  if (message.type === "mcpNotification") {
    dispatchCodexAppServerMessage("mcp-notification", {
      hostId: message.hostId,
      notification: message.notification,
    });
    return;
  }

  if (message.type === "sidebarSyncUpdated") return;

  dispatchCodexAppServerMessage("error", {
    hostId: message.hostId,
    message: message.message,
    detail: message.detail,
  });
}

export function startLocalConversationHostBridge(): () => void {
  bridgeRefCount += 1;
  if (!unsubscribeHostMessages) {
    unsubscribeHostMessages = subscribeCodexHostMessages((message) => {
      applyHostMessage(message);
    });
  }

  return () => {
    bridgeRefCount = Math.max(0, bridgeRefCount - 1);
    if (bridgeRefCount === 0) {
      unsubscribeHostMessages?.();
      unsubscribeHostMessages = null;
    }
  };
}

export function __resetLocalConversationHostBridgeForTests(): void {
  bridgeRefCount = 0;
  unsubscribeHostMessages?.();
  unsubscribeHostMessages = null;
}
