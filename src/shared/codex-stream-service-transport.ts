import type { ConversationCoordinationHost } from "./codex-client-coordination";
import type { ConversationStreamTransport } from "./codex-conversation-stream";

/** Manager calls are sent immediately; service completion never accepts or rolls back a revision. */
export const createConversationStreamServiceTransport = <Document, Patch, TextChange>(
  host: ConversationCoordinationHost,
): ConversationStreamTransport<Document, Patch, TextChange> => ({
  sendState: (conversationId, hostId, targetClientIds, change) =>
    host.threadStreamStateChanged({ params: { conversationId, hostId, change }, targetClientIds }),
  sendFollowing: (conversationId, hostId, following, targetClientIds) =>
    host.threadStreamFollowingChanged({
      params: { conversationId, hostId, following },
      targetClientIds,
    }),
  requestFollowingStatus: (conversationId, hostId) =>
    host.threadStreamFollowingStatusRequested({ conversationId, hostId }),
  setThreadOwnership: (conversationId, hostId, ownsThread) =>
    host.setThreadOwnership({ conversationId, hostId, ownsThread }),
});
