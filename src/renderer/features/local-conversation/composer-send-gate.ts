import {
  isLocalConversationWriterConflict,
  type LocalConversationAttachmentState,
} from "./conversation-attachment-state";
import type { CodexConversationResumeState } from "@/lib/types";
import type { ComposerSendGate } from "./thread-stage-types";

/** How long a chat may reconnect quietly before its composer says so. */
export const CHAT_RECONNECTING_NOTICE_DELAY_MS = 3_000;

/**
 * What a started chat's connection keeps it from sending. Reconnecting is quiet at first, since
 * it usually finishes before a message is written; a failure says what happened and offers Retry.
 */
export function chatConnectionSendGate(input: {
  readonly resumeState: CodexConversationResumeState | null;
  readonly attachmentState: LocalConversationAttachmentState;
  /** The reconnect has outlasted {@link CHAT_RECONNECTING_NOTICE_DELAY_MS}. */
  readonly reconnectingLong: boolean;
  /** The transcript is empty and already says the chat could not be restored. */
  readonly failureShownInTranscript: boolean;
  readonly retry: () => Promise<void>;
}): ComposerSendGate | null {
  const { attachmentState } = input;
  const retry = { label: "Retry", pendingLabel: "Retrying…", run: input.retry };
  if (isLocalConversationWriterConflict(attachmentState)) {
    return {
      unsentReason: "This chat is open in another app",
      notice: {
        key: "chat:open-elsewhere",
        tone: "warning",
        title: "This chat is open in another app",
        detail: "Close it there to continue here",
        actions: [retry],
      },
    };
  }
  if (attachmentState.status === "failed") {
    return {
      unsentReason: "Nodex couldn’t connect to this chat",
      notice: input.failureShownInTranscript
        ? null
        : {
            key: "chat:connection-failed",
            tone: "danger",
            title: "Couldn’t connect to this chat",
            detail: attachmentState.message,
            actions: [retry],
          },
    };
  }
  if (
    attachmentState.status === "attaching" ||
    (input.resumeState !== null && input.resumeState !== "resumed")
  ) {
    return {
      unsentReason: "Still reconnecting to this chat",
      notice: input.reconnectingLong
        ? { key: "chat:reconnecting", tone: "warning", title: "Reconnecting to this chat…" }
        : null,
    };
  }
  return null;
}
