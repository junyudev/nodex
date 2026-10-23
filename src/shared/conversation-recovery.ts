import type { CodexErrorInfo } from "@nodex/codex-app-server-protocol/v2";

export type ConversationRecoveryState = "retrying" | "recovered" | "failed" | "stopped";
export type ConversationRecoveryReason =
  | "connection"
  | "overloaded"
  | "rate_limit"
  | "usage_limit"
  | "authentication"
  | "unknown";

/** Current request recovery, separate from the diagnostic event that started it. */
export interface ConversationRecovery {
  readonly state: ConversationRecoveryState;
  readonly reason: ConversationRecoveryReason;
  readonly attempt: number | null;
  readonly maxAttempts: number | null;
  /** Provider-reported next attempt time. Null when the provider gives no delay. */
  readonly retryAt: number | null;
  readonly updatedAt: number | null;
}

export function conversationRecoveryReason(code: string | null): ConversationRecoveryReason {
  if (code === null) return "unknown";
  if (code === "api_error_529" || code === "overloaded" || code === "serverOverloaded")
    return "overloaded";
  if (code === "api_error_429" || code === "rate_limit" || code === "rateLimitExceeded")
    return "rate_limit";
  if (code === "usageLimitExceeded" || code === "billing_error" || code === "blocking_limit")
    return "usage_limit";
  if (code === "unauthorized" || code === "authentication_failed" || code === "api_error_401")
    return "authentication";
  if (
    code === "httpConnectionFailed" ||
    code === "responseStreamConnectionFailed" ||
    code === "responseStreamDisconnected" ||
    code === "responseTooManyFailedAttempts"
  )
    return "connection";
  return "unknown";
}

export function codexConversationRecoveryReason(
  errorInfo: CodexErrorInfo | null,
): ConversationRecoveryReason {
  if (errorInfo === null) return "unknown";
  if (typeof errorInfo === "string") return conversationRecoveryReason(errorInfo);
  const [code, details] = Object.entries(errorInfo)[0] ?? [];
  if (details && typeof details === "object" && "httpStatusCode" in details) {
    const statusReason = conversationRecoveryReason(`api_error_${details.httpStatusCode}`);
    if (statusReason !== "unknown") return statusReason;
  }
  return conversationRecoveryReason(code ?? null);
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
