import type { ConversationRecovery } from "../../../../shared/conversation-recovery";
import type { CodexTranscriptEntry } from "../../../../shared/types";

export const RECOVERY_REVEAL_DELAY_MS = 250;
export const RECOVERY_CONFIRMATION_MS = 1800;

function attemptLabel(recovery: ConversationRecovery): string | null {
  const { attempt, maxAttempts } = recovery;
  if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (maxAttempts === null || !Number.isSafeInteger(maxAttempts) || maxAttempts < attempt)
    return `Attempt ${attempt}`;
  return `${attempt}/${maxAttempts}`;
}

export function recoveryRetrySeconds(recovery: ConversationRecovery, now: number): number | null {
  if (recovery.state !== "retrying" || recovery.retryAt === null) return null;
  if (!Number.isFinite(recovery.retryAt)) return null;
  return Math.max(0, Math.ceil((recovery.retryAt - now) / 1000));
}

export function recoveryStatusLabel(recovery: ConversationRecovery): string {
  if (recovery.state === "recovered")
    return recovery.reason === "connection" ? "Connection restored" : "Request resumed";
  if (recovery.state === "stopped") return "Stopped";
  if (recovery.state === "failed") {
    switch (recovery.reason) {
      case "authentication":
        return "Sign-in required";
      case "usage_limit":
        return "Usage limit reached";
      case "rate_limit":
        return "Request limit reached";
      case "overloaded":
        return "Service is unavailable";
      case "connection":
        return "Connection could not be restored";
      case "unknown":
        return "Request failed";
    }
  }
  switch (recovery.reason) {
    case "connection":
      return "Reconnecting";
    case "overloaded":
      return "Service is busy";
    case "rate_limit":
      return "Rate limited";
    default:
      return "Retrying request";
  }
}

export function recoveryProgressLabel(recovery: ConversationRecovery, now: number): string | null {
  if (recovery.state !== "retrying") return null;
  const seconds = recoveryRetrySeconds(recovery, now);
  const wait = seconds !== null && seconds > 0 ? `Retrying in ${seconds}s` : null;
  const activeAttempt =
    wait === null && (recovery.reason === "overloaded" || recovery.reason === "rate_limit")
      ? "Retrying"
      : null;
  return [wait ?? activeAttempt, attemptLabel(recovery)].filter(Boolean).join(" · ") || null;
}

export function recoveryAction(
  recovery: ConversationRecovery | undefined,
  isLatestTurn: boolean,
  isStreamingTurn: boolean,
): "continue" | "manage-provider" | null {
  if (!recovery || recovery.state !== "failed" || !isLatestTurn || isStreamingTurn) return null;
  if (recovery.reason === "authentication" || recovery.reason === "usage_limit")
    return "manage-provider";
  return "continue";
}

/** Preserve the provider's evidence without treating its raw message as the current status. */
export function recoveryDiagnosticText(entry: CodexTranscriptEntry): string {
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
  const messages = [rawMessage?.trim(), entry.additionalDetails?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  const recovery = entry.recovery;
  if (!recovery)
    return rawMessage !== entry.markdownText
      ? [...new Set(messages)].join("\n\n")
      : (entry.additionalDetails?.trim() ?? "");
  const metadata = [
    `State: ${recovery.state}`,
    `Reason: ${recovery.reason}`,
    attemptLabel(recovery) ? `Retry: ${attemptLabel(recovery)}` : null,
  ].filter(Boolean);
  return [...new Set(messages), metadata.join("\n")].join("\n\n");
}
