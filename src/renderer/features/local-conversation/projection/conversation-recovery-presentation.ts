import { formatCompactDurationUnit } from "../thread-worked-for-time";
import { defineMessage, getIntl, type IntlShape } from "@/lib/i18n";
import type { ConversationRecovery } from "../../../../shared/conversation-recovery";
import type { CodexTranscriptEntry } from "../../../../shared/types";

export const RECOVERY_REVEAL_DELAY_MS = 250;
export const RECOVERY_CONFIRMATION_MS = 1800;

function attemptLabel(recovery: ConversationRecovery, intl: IntlShape | null): string | null {
  const { attempt, maxAttempts } = recovery;
  if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (maxAttempts === null || !Number.isSafeInteger(maxAttempts) || maxAttempts < attempt)
    return intl
      ? intl.formatMessage(
          {
            id: "conversation.conversationRecoveryPresentation.attempt",
            defaultMessage: "Attempt {attempt}",
          },
          { attempt },
        )
      : `Attempt ${attempt}`;
  return `${attempt}/${maxAttempts}`;
}

export function recoveryRetrySeconds(recovery: ConversationRecovery, now: number): number | null {
  if (recovery.state !== "retrying" || recovery.retryAt === null) return null;
  if (!Number.isFinite(recovery.retryAt)) return null;
  return Math.max(0, Math.ceil((recovery.retryAt - now) / 1000));
}

export function recoveryStatusMessage(recovery: ConversationRecovery) {
  if (recovery.state === "recovered")
    return recovery.reason === "connection"
      ? defineMessage({
          id: "conversation.conversationRecoveryPresentation.connectionRestored",
          defaultMessage: "Connection restored",
        })
      : defineMessage({
          id: "conversation.conversationRecoveryPresentation.requestResumed",
          defaultMessage: "Request resumed",
        });
  if (recovery.state === "stopped")
    return defineMessage({
      id: "conversation.conversationRecoveryPresentation.stopped",
      defaultMessage: "Stopped",
    });
  if (recovery.state === "failed") {
    switch (recovery.reason) {
      case "context_budget":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.needsCompaction",
          defaultMessage: "Conversation needs compaction",
        });
      case "model_not_applied":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.modelCouldNotBeApplied",
          defaultMessage: "Model could not be applied",
        });
      case "authentication":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.signInRequired",
          defaultMessage: "Sign-in required",
        });
      case "usage_limit":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.usageLimit",
          defaultMessage: "Usage limit reached",
        });
      case "rate_limit":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.requestLimit",
          defaultMessage: "Request limit reached",
        });
      case "overloaded":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.serviceUnavailable",
          defaultMessage: "Service is unavailable",
        });
      case "connection":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.connectionLost",
          defaultMessage: "Connection could not be restored",
        });
      case "process_lost":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.agentStopped",
          defaultMessage: "Agent stopped unexpectedly",
        });
      case "unrecoverable":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.couldNotReopen",
          defaultMessage: "Couldn't reopen this conversation",
        });
      case "refused":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.declined",
          defaultMessage: "Request declined",
        });
      case "unknown":
        return defineMessage({
          id: "conversation.conversationRecoveryPresentation.failed",
          defaultMessage: "Request failed",
        });
    }
  }
  switch (recovery.reason) {
    case "connection":
      return recovery.waitingForNetwork
        ? defineMessage({
            id: "conversation.conversationRecoveryPresentation.waitingForNetwork",
            defaultMessage: "Waiting for network",
          })
        : defineMessage({
            id: "conversation.conversationRecoveryPresentation.reconnecting",
            defaultMessage: "Reconnecting",
          });
    case "process_lost":
      return defineMessage({
        id: "conversation.conversationRecoveryPresentation.resuming",
        defaultMessage: "Resuming",
      });
    case "overloaded":
      return defineMessage({
        id: "conversation.conversationRecoveryPresentation.busy",
        defaultMessage: "Service is busy",
      });
    case "rate_limit":
      return defineMessage({
        id: "conversation.conversationRecoveryPresentation.rateLimited",
        defaultMessage: "Rate limited",
      });
    default:
      return defineMessage({
        id: "conversation.conversationRecoveryPresentation.retryingRequest",
        defaultMessage: "Retrying request",
      });
  }
}

export function recoveryStatusLabel(
  recovery: ConversationRecovery,
  intl: IntlShape = getIntl(),
): string {
  return intl.formatMessage(recoveryStatusMessage(recovery));
}

/** Waits read in the largest whole unit that still counts down: 45s, 2m, 1h 5m. */
function retryWaitLabel(seconds: number, intl: IntlShape): string {
  if (seconds < 60) return formatCompactDurationUnit("second", seconds, intl);
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return formatCompactDurationUnit("minute", minutes, intl);

  const hoursLabel = formatCompactDurationUnit("hour", Math.floor(minutes / 60), intl);
  const rest = minutes % 60;
  return rest === 0
    ? hoursLabel
    : `${hoursLabel} ${formatCompactDurationUnit("minute", rest, intl)}`;
}

export function recoveryProgressLabel(
  recovery: ConversationRecovery,
  now: number,
  intl: IntlShape = getIntl(),
): string | null {
  if (recovery.state !== "retrying") return null;
  const seconds = recoveryRetrySeconds(recovery, now);
  const wait =
    seconds !== null && seconds > 0
      ? intl.formatMessage(
          {
            id: "conversation.conversationRecoveryPresentation.retryingIn",
            defaultMessage: "Retrying in {duration}",
          },
          { duration: retryWaitLabel(seconds, intl) },
        )
      : null;
  const activeAttempt =
    wait === null && (recovery.reason === "overloaded" || recovery.reason === "rate_limit")
      ? intl.formatMessage({
          id: "conversation.conversationRecoveryPresentation.retrying",
          defaultMessage: "Retrying",
        })
      : null;
  return [wait ?? activeAttempt, attemptLabel(recovery, intl)].filter(Boolean).join(" · ") || null;
}

export function recoveryAction(
  recovery: ConversationRecovery | undefined,
  isLatestTurn: boolean,
  isStreamingTurn: boolean,
): "continue" | "compact-and-retry" | "manage-provider" | null {
  if (!recovery || recovery.state !== "failed" || !isLatestTurn || isStreamingTurn) return null;
  // Continuing would ask the provider to reopen the same conversation again.
  if (recovery.reason === "unrecoverable") return null;
  if (recovery.reason === "context_budget") return "compact-and-retry";
  if (recovery.reason === "authentication" || recovery.reason === "usage_limit")
    return "manage-provider";
  return "continue";
}

/** Preserve the provider's evidence without treating its raw message as the current status. */
function recoveryEvidence(entry: CodexTranscriptEntry): string[] {
  const raw = entry.rawItem;
  const rawMessage =
    raw !== null &&
    typeof raw === "object" &&
    "type" in raw &&
    raw.type === "error" &&
    "message" in raw &&
    typeof raw.message === "string"
      ? raw.message
      : entry.markdownText;
  const details = entry.additionalDetails?.trim();
  // Without recovery, the row's label is already the display message.
  if (!entry.recovery && rawMessage === entry.markdownText) return details ? [details] : [];
  return [
    ...new Set([rawMessage?.trim(), details].filter((value): value is string => Boolean(value))),
  ];
}

/** What the provider reported, without repeating the status row's state, cause or attempt. */
export function recoveryDiagnosticSummary(entry: CodexTranscriptEntry): string {
  return recoveryEvidence(entry).join("\n");
}

/** Provider evidence plus the recovery state, for copying and Conversation Markdown. */
export function recoveryDiagnosticText(entry: CodexTranscriptEntry): string {
  const evidence = recoveryEvidence(entry);
  const recovery = entry.recovery;
  if (!recovery) return evidence.join("\n\n");
  const metadata = [
    `State: ${recovery.state}`,
    `Reason: ${recovery.reason}`,
    attemptLabel(recovery, null) ? `Retry: ${attemptLabel(recovery, null)}` : null,
  ].filter(Boolean);
  return [...evidence, metadata.join("\n")].join("\n\n");
}
