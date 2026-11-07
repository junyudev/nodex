import type { OrchestrationV2ProviderFailure } from "@nodex/runtime-contracts";

/**
 * What a failed reply ran into, derived once from the failure's structured evidence.
 * Automatic recovery and every presentation read this one classification; a new
 * provider code is taught here rather than to each consumer.
 */
export type ProviderFailureCause =
  /** The network or Nodex's link to the Agent dropped. */
  | "connection"
  /** The service is busy or out of capacity. */
  | "overloaded"
  /** A request-rate limit that clears on its own, unlike a usage limit. */
  | "rate_limit"
  /** The Agent's process stopped, or never confirmed the reply started. */
  | "process_lost"
  | "usage_limit"
  | "authentication"
  | "context_budget"
  /** The provider rejected this request; sending it again cannot help. */
  | "refused"
  /** The provider cannot reopen the captured conversation. */
  | "unrecoverable"
  /** No structured evidence names the cause. */
  | "unknown";

export type ProviderFailureEvidence = Pick<
  OrchestrationV2ProviderFailure,
  "class" | "code" | "message" | "diagnostic" | "contextBudget" | "httpStatusCode"
>;

/** Nodex-originated codes for failures it observes itself rather than hears from the Agent. */
export const NODEX_FAILURE_CODES = {
  /** The Agent process exited before the reply finished. */
  processExited: "provider_process_exited",
  /** The Agent never confirmed that the reply started. */
  turnStartUnconfirmed: "turn_start_unconfirmed",
  /** Nodex lost the Agent's event stream and couldn't confirm how the reply ended. */
  observationLost: "observation_lost",
  /** The Agent's event stream closed before the reply finished. */
  eventStreamLost: "provider_event_stream_lost",
  /** Nodex could not confirm whether the conversation history reached the Agent. */
  deliveryUncertain: "context_handoff_delivery_uncertain",
  /** Another owner holds the native turn this reply addressed. */
  turnOwnershipConflict: "turn_ownership_conflict",
  /** Background work must finish or stop before this reply can replace the query. */
  backgroundWorkBlocks: "background_work_blocks_reply",
} as const;

const CONNECTION_CODES = new Set<string>([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "transport_error",
  NODEX_FAILURE_CODES.observationLost,
]);
const OVERLOADED_CODES = new Set<string>([
  "serverOverloaded",
  "internalServerError",
  "overloaded",
  "flexUnavailable",
  "policyCapacityUnavailable",
]);
const RATE_LIMIT_CODES = new Set<string>(["rateLimitExceeded", "rate_limit"]);
const PROCESS_LOST_CODES = new Set<string>([
  NODEX_FAILURE_CODES.processExited,
  NODEX_FAILURE_CODES.turnStartUnconfirmed,
  NODEX_FAILURE_CODES.eventStreamLost,
]);
const USAGE_LIMIT_CODES = new Set<string>([
  "usageLimitExceeded",
  "billing_error",
  "blocking_limit",
]);
const AUTHENTICATION_CODES = new Set<string>(["unauthorized", "authentication_failed"]);
const CONTEXT_BUDGET_CODES = new Set<string>(["context_budget_exhausted"]);
const REFUSED_CODES = new Set<string>([
  "badRequest",
  "invalid_request",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
  "modelNotFound",
  "sandboxError",
  "threadRollbackFailed",
  "activeTurnNotSteerable",
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "context_handoff_unsupported",
  // Claude results that end because a configured limit was reached.
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
  NODEX_FAILURE_CODES.deliveryUncertain,
  NODEX_FAILURE_CODES.turnOwnershipConflict,
  NODEX_FAILURE_CODES.backgroundWorkBlocks,
]);
const UNRECOVERABLE_CODES = new Set<string>(["native_session_unrecoverable"]);

const DISCONNECT_EVIDENCE =
  /stream (?:ended|closed|disconnected)|(?:connection|stream) (?:reset|lost)|unexpected (?:eof|end of stream)|disconnected|disconnect(?:ion)?\b/iu;

/** The upstream HTTP status, preferring the structured field over a status-encoding code. */
export function providerFailureHttpStatus(failure: ProviderFailureEvidence): number | null {
  if (failure.httpStatusCode != null) return failure.httpStatusCode;
  const encoded = /^api_error_(\d{3})$/u.exec(failure.code ?? "");
  return encoded ? Number(encoded[1]) : null;
}

/**
 * Typed limits and refusals outrank transport evidence, which outranks a generic
 * status, which outranks a code. A class alone establishes only transport loss or
 * a usage limit; unknown codes stay unknown rather than borrowing a nearby cause.
 */
export function providerFailureCause(failure: ProviderFailureEvidence): ProviderFailureCause {
  const code = failure.code;
  if (failure.contextBudget !== undefined || (code !== null && CONTEXT_BUDGET_CODES.has(code)))
    return "context_budget";
  if (failure.class === "usage_limit" || (code !== null && USAGE_LIMIT_CODES.has(code)))
    return "usage_limit";
  if (code !== null && UNRECOVERABLE_CODES.has(code)) return "unrecoverable";
  if (code !== null && AUTHENTICATION_CODES.has(code)) return "authentication";
  if (failure.class === "permission_error" || failure.class === "validation_error")
    return "refused";
  if (code !== null && REFUSED_CODES.has(code)) return "refused";

  const status = providerFailureHttpStatus(failure);
  if (status === 401) return "authentication";
  if (status === 429) return "rate_limit";
  // A gateway that cannot reach the provider (common behind a local proxy while offline)
  // answers 502/504; that is lost connectivity, not a busy service.
  if ((status === 502 || status === 504) && code !== "serverOverloaded") return "connection";
  if (status !== null && status >= 500 && status <= 599) return "overloaded";
  if (status !== null) return "refused";

  if (code !== null) {
    if (RATE_LIMIT_CODES.has(code)) return "rate_limit";
    if (OVERLOADED_CODES.has(code)) return "overloaded";
    if (PROCESS_LOST_CODES.has(code)) return "process_lost";
    if (CONNECTION_CODES.has(code)) return "connection";
    if (code === "other" && DISCONNECT_EVIDENCE.test(`${failure.message}\n${failure.diagnostic ?? ""}`))
      return "connection";
  }
  return failure.class === "transport_error" ? "connection" : "unknown";
}
