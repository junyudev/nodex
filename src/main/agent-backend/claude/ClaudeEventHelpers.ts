import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConversationTokenUsage } from "../../../shared/agent-conversation";
import type { AgentConversationTurnOutcome } from "../AgentConversationProjection";

// This registry is exhaustive for the installed SDK. Upgrades require an explicit disposition.
export const CLAUDE_EVENT_DISPOSITIONS = {
  assistant: "content",
  user: "content",
  result: "outcome",
  stream_event: "content",
  system: "lifecycle",
  tool_progress: "content",
  tool_use_summary: "content",
  auth_status: "diagnostic",
  rate_limit_event: "diagnostic",
  prompt_suggestion: "diagnostic",
  conversation_reset: "lifecycle",
} satisfies Record<SDKMessage["type"], "content" | "outcome" | "lifecycle" | "diagnostic">;

export const CLAUDE_SYSTEM_EVENT_DISPOSITIONS = {
  api_retry: "diagnostic",
  background_tasks_changed: "lifecycle",
  commands_changed: "lifecycle",
  compact_boundary: "content",
  control_request_progress: "diagnostic",
  elicitation_complete: "lifecycle",
  files_persisted: "content",
  hook_progress: "diagnostic",
  hook_response: "diagnostic",
  hook_started: "diagnostic",
  informational: "diagnostic",
  init: "lifecycle",
  local_command_output: "content",
  memory_recall: "diagnostic",
  mirror_error: "diagnostic",
  model_refusal_fallback: "lifecycle",
  model_refusal_no_fallback: "diagnostic",
  notification: "diagnostic",
  permission_denied: "diagnostic",
  plugin_install: "diagnostic",
  session_state_changed: "lifecycle",
  status: "lifecycle",
  task_notification: "lifecycle",
  task_progress: "lifecycle",
  task_started: "lifecycle",
  task_updated: "lifecycle",
  thinking_tokens: "diagnostic",
  worker_shutting_down: "diagnostic",
} satisfies Record<
  Extract<SDKMessage, { type: "system" }>["subtype"],
  "content" | "lifecycle" | "diagnostic"
>;

export const claudeRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

export const claudeText = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 64 * 1024);
  if (Array.isArray(value))
    return value
      .map((part) => {
        const block = claudeRecord(part);
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 64 * 1024);
  return JSON.stringify(value)?.slice(0, 64 * 1024) ?? "";
};

export const claudeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export const claudeTokenUsage = (value: unknown): AgentConversationTokenUsage => {
  const usage = claudeRecord(value);
  return {
    input: claudeNumber(usage.input_tokens ?? usage.inputTokens),
    output: claudeNumber(usage.output_tokens ?? usage.outputTokens),
    cacheRead: claudeNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    cacheWrite: claudeNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
  };
};

const failureReasons = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "max_turns",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
]);
const cancellationReasons = new Set([
  "aborted_streaming",
  "aborted_tools",
  "hook_stopped",
  "stop_hook_prevented",
]);

/** Structured native outcome wins over the result subtype, which can still say success on API errors. */
export const deriveClaudeTurnOutcome = (
  message: SDKResultMessage,
  hints: { readonly cancelled?: boolean; readonly authenticationFailure?: string | null } = {},
): AgentConversationTurnOutcome & { readonly authenticationRequired: boolean } => {
  const reason = message.terminal_reason ?? message.stop_reason;
  if (hints.cancelled || (reason && cancellationReasons.has(reason)))
    return {
      status: "cancelled",
      stopReason: "cancelled",
      error: null,
      authenticationRequired: false,
    };
  const failed =
    message.is_error ||
    message.subtype !== "success" ||
    (reason !== null && reason !== undefined && failureReasons.has(reason));
  if (!failed && !hints.authenticationFailure)
    return {
      status: "completed",
      stopReason: message.stop_reason ?? "end_turn",
      error: null,
      authenticationRequired: false,
    };
  const error =
    (hints.authenticationFailure ??
      (message.subtype === "success" ? message.result : message.errors.join("\n"))) ||
    `Claude turn ended: ${reason ?? message.subtype}`;
  const startup = "startup_failure_reason" in message ? message.startup_failure_reason : undefined;
  const authenticationRequired =
    Boolean(hints.authenticationFailure) ||
    startup === "gateway_signin_required" ||
    startup === "org_verify_failed" ||
    startup === "org_pin_api_key_conflict";
  return {
    status: "failed",
    stopReason: "error",
    error: error.slice(0, 8192),
    authenticationRequired,
  };
};
