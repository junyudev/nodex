import type { CodexErrorInfo } from "@nodex/codex-app-server-protocol/v2";
import {
  providerFailureCause,
  type ProviderFailureCause,
} from "@nodex/agent-runtime/failure-cause";

export type ConversationRecoveryState = "retrying" | "recovered" | "failed" | "stopped";
/** The cause the Agent runtime's recovery policy reads, so labels and retries never disagree. */
export type ConversationRecoveryReason = ProviderFailureCause;

/** Current request recovery, separate from the diagnostic event that started it. */
export interface ConversationRecovery {
  readonly state: ConversationRecoveryState;
  readonly reason: ConversationRecoveryReason;
  readonly attempt: number | null;
  readonly maxAttempts: number | null;
  /** Provider-reported next attempt time. Null when the provider gives no delay. */
  readonly retryAt: number | null;
  readonly updatedAt: number | null;
  /** The provider reports it is waiting for the network to come back, without a retry budget. */
  readonly waitingForNetwork?: boolean;
}

/** Codex keeps a turn alive through an outage and says so in its retry message. */
export function isWaitingForNetworkMessage(message: string | null | undefined): boolean {
  return message != null && /\bwaiting for (?:the )?network\b/i.test(message);
}

/** Codex's native error evidence, classified like the runtime classifies the same failure. */
export function codexConversationRecoveryReason(
  errorInfo: CodexErrorInfo | null,
  message = "",
): ConversationRecoveryReason {
  if (errorInfo === null) return "unknown";
  const [code, details] =
    typeof errorInfo === "string" ? [errorInfo, null] : (Object.entries(errorInfo)[0] ?? []);
  const httpStatusCode =
    details !== null &&
    typeof details === "object" &&
    "httpStatusCode" in details &&
    typeof details.httpStatusCode === "number"
      ? details.httpStatusCode
      : undefined;
  return providerFailureCause({
    class: "provider_error",
    code: code ?? null,
    message,
    ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
  });
}

export function parseConversationRetryProgress(
  message: string,
): Pick<ConversationRecovery, "attempt" | "maxAttempts"> | null {
  const match =
    /\b(?:reconnecting|retrying)(?:\.{3}|…)?\s+(\d+)\s*\/\s*(\d+)\b(?!\.\d|\s*\/)/i.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(maxAttempts)) return null;
  if (attempt < 1 || maxAttempts < 1) return null;
  return { attempt, maxAttempts };
}
