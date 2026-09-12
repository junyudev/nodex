import type { ConversationCoordinationEvent } from "./codex-client-coordination";
import type { ConversationCoordinationBroadcast } from "./codex-coordination-view";
import type {
  ConversationStream,
  ConversationStreamChange,
  ConversationStreamTextChange,
} from "./codex-conversation-stream";

/** Service broadcasts reach every manager; conversation messages are selected by host. */
export function receiveConversationStreamServiceEvent<
  Document,
  Patch,
  TextChange extends ConversationStreamTextChange,
>(
  stream: ConversationStream<Document, Patch, TextChange>,
  hostId: string,
  method: ConversationCoordinationBroadcast,
  event: ConversationCoordinationEvent,
): void {
  if (method === "ipcConnectionReset") {
    stream.resetIpcConnection();
    return;
  }
  if (method === "clientStatusChanged") {
    const params = event.params as {
      clientId: string;
      status: "connected" | "disconnected";
      isSelf?: boolean;
    };
    stream.receiveClientStatus(params.clientId, params.status, params.isSelf);
    return;
  }
  const params = event.params as {
    hostId: string;
    conversationId: string;
    following: boolean;
    change: ConversationStreamChange<Document, Patch, TextChange>;
  };
  if (params.hostId !== hostId) return;
  switch (method) {
    case "threadStreamStateChanged":
      stream.receiveState(params.conversationId, event.sourceClientId, params.change);
      return;
    case "threadStreamFollowingChanged":
      stream.receiveFollowing(params.conversationId, event.sourceClientId, params.following);
      return;
    case "threadStreamFollowingStatusRequested":
      stream.receiveFollowingStatusRequest(params.conversationId, event.sourceClientId);
      return;
  }
}
