import type { CodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";

const FAILURE_REASONS = [
  ["expected active turn id", "active_turn_mismatch"],
  ["Configuration was modified since last read", "config_modified"],
  ["os error 28", "disk_full"],
  ["os error 112", "disk_full"],
  ["no goal exists", "goal_not_found"],
  ["Invalid configuration:", "invalid_config"],
  ["expected any valid TOML value", "invalid_config"],
  ["AbsolutePathBuf deserialized without a base path", "invalid_config"],
  ["failed to load configuration:", "invalid_config"],
  ["no active turn to", "no_active_turn"],
  ["Codex app-server is not available", "remote_unavailable"],
  ["thread rollback requires persisted thread history", "rollback_history_missing"],
  ["rollback already in progress", "rollback_in_progress"],
  ["no rollout found for thread id", "rollout_not_found"],
  ["failed to resolve rollout path", "rollout_not_found"],
  [" is archived", "thread_archived"],
  ["thread not found:", "thread_not_found"],
  ["Cannot rollback while a turn is in progress", "turn_in_progress"],
  ["Unauthorized", "unauthorized"],
  ["auth failed", "unauthorized"],
] as const;

function isJsonRpcErrorCode(code: unknown): code is number {
  return (
    typeof code === "number" &&
    Number.isInteger(code) &&
    ((code >= -32099 && code <= -32000) || code === -32700 || (code >= -32603 && code <= -32600))
  );
}

function failureReason(failure: CodexNativeRequestFailure): string | null {
  if (
    failure.message.includes("Connection for host ID") &&
    failure.message.includes(" not found")
  ) {
    return "remote_unavailable";
  }
  return FAILURE_REASONS.find(([fragment]) => failure.message.includes(fragment))?.[1] ?? null;
}

/** Exact response-route error attributes emitted for app-server JSON-RPC failures. */
export function codexAppServerResponseErrorTraceAttributes(
  failure: CodexNativeRequestFailure,
): Readonly<Record<string, string | number>> {
  if (!isJsonRpcErrorCode(failure.code)) return {};
  const reason = failureReason(failure);
  return {
    "app_server.error_code": failure.code,
    ...(reason === null ? {} : { "app_server.failure_reason": reason }),
  };
}
