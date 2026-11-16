import { defineMessages } from "@/lib/i18n";

export const RUNTIME_QUEUE_HOLD_MESSAGES = defineMessages({
  failed: {
    id: "conversation.agentRuntimeConversationOwner.queuePausedAfterFailure",
    defaultMessage: "Queue paused because a message failed",
  },
  paused: {
    id: "conversation.agentRuntimeConversationOwner.queuePaused",
    defaultMessage: "Queue paused",
  },
});
