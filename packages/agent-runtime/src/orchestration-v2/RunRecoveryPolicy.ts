import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2RunRecovery,
  OrchestrationV2RunRecoveryKind,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type RunRecoveryKind = OrchestrationV2RunRecoveryKind | "none";

/** Retain across attempts (and failure-kind changes), until model output or Run settlement. */
export type RunRecoveryStreak = Pick<OrchestrationV2RunRecovery, "streakStartedAt" | "attempt">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CONNECTION_DELAYS = [5_000, 10_000, 20_000, 40_000, MINUTE];
const BOUNDED_DELAYS = {
  overloaded: [10_000, 30_000, 2 * MINUTE, 5 * MINUTE],
  rate_limit: [MINUTE, 5 * MINUTE, 15 * MINUTE],
  process_lost: [5_000, 30_000, 2 * MINUTE],
} as const;

/** Structured evidence wins over generic transport codes; usage limits never auto-resume. */
export function classifyRunRecovery(failure: OrchestrationV2ProviderFailure): RunRecoveryKind {
  if (
    failure.class === "usage_limit" ||
    failure.class === "permission_error" ||
    failure.class === "validation_error" ||
    failure.contextBudget !== undefined ||
    failure.retryable === false
  )
    return "none";

  const code = failure.code;
  if (
    code === "usageLimitExceeded" ||
    code === "contextWindowExceeded" ||
    code === "sessionBudgetExceeded" ||
    code === "context_budget_exhausted" ||
    code === "unauthorized" ||
    code === "badRequest" ||
    code === "cyberPolicy" ||
    code === "misalignmentPolicyViolation" ||
    code === "tooManyDenials" ||
    code === "authentication_failed" ||
    code === "invalid_request"
  )
    return "none";

  const encodedStatus = /^api_error_(\d{3})$/u.exec(code ?? "");
  const status = failure.httpStatusCode ?? (encodedStatus ? Number(encodedStatus[1]) : null);
  if (status === 429) return "rate_limit";
  // A gateway that cannot reach the provider (common behind a local proxy while offline)
  // answers 502/504; that is lost connectivity, not a busy service.
  if ((status === 502 || status === 504) && code !== "serverOverloaded") return "connection";
  if (status !== null && status >= 500 && status <= 599) return "overloaded";
  if (status !== null) return "none";

  switch (code) {
    case "rateLimitExceeded":
    case "rate_limit":
      return "rate_limit";
    case "serverOverloaded":
    case "internalServerError":
    case "overloaded":
      return "overloaded";
    case "provider_process_exited":
    case "turn_start_unconfirmed":
      return "process_lost";
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
    case "observation_lost":
      return "connection";
    case "other": {
      const details = `${failure.message}\n${failure.diagnostic ?? ""}`;
      if (
        /stream (?:ended|closed|disconnected)|(?:connection|stream) (?:reset|lost)|unexpected (?:eof|end of stream)|disconnected|disconnect(?:ion)?\b/iu.test(
          details,
        )
      ) {
        return "connection";
      }
      return "none";
    }
    default:
      return failure.class === "transport_error" || code === "transport_error"
        ? "connection"
        : "none";
  }
}

export type RunRecoveryDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: OrchestrationV2RunRecoveryKind;
      readonly status: "exhausted";
      readonly streakStartedAt: DateTime.Utc;
      readonly maxAttempts: number;
    }
  | (OrchestrationV2RunRecovery & {
      readonly status: "scheduled";
      readonly delayMs: number;
    });

/** Pure scheduling: callers supply the observation time, never a wall-clock timer. */
export function nextRunRecovery(input: {
  readonly failure: OrchestrationV2ProviderFailure;
  readonly streak: RunRecoveryStreak | null;
  readonly now: DateTime.Utc;
}): RunRecoveryDecision {
  const { failure, now, streak } = input;
  const kind = classifyRunRecovery(failure);
  if (kind === "none") return { kind };

  const attempt = (streak?.attempt ?? 0) + 1;
  const streakStartedAt = streak?.streakStartedAt ?? now;
  const maxAttempts = kind === "connection" ? null : BOUNDED_DELAYS[kind].length;
  if (maxAttempts !== null && attempt > maxAttempts) {
    return { kind, status: "exhausted", streakStartedAt, maxAttempts };
  }

  const delayMs = recoveryDelayMs(kind, attempt, failure, streakStartedAt, now);
  return {
    kind,
    status: "scheduled",
    failure,
    streakStartedAt,
    attempt,
    maxAttempts,
    delayMs,
    nextAttemptAt: DateTime.add(now, { milliseconds: delayMs }),
  };
}

function recoveryDelayMs(
  kind: OrchestrationV2RunRecoveryKind,
  attempt: number,
  failure: OrchestrationV2ProviderFailure,
  streakStartedAt: DateTime.Utc,
  now: DateTime.Utc,
): number {
  if (kind === "connection") {
    if (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(streakStartedAt) >= HOUR) {
      return 5 * MINUTE;
    }
    return CONNECTION_DELAYS[Math.min(attempt, CONNECTION_DELAYS.length) - 1]!;
  }
  if (kind === "rate_limit") {
    const reset = failure.resetAt == null ? Option.none() : DateTime.make(failure.resetAt);
    if (Option.isSome(reset)) {
      return Math.min(
        HOUR,
        Math.max(0, DateTime.toEpochMillis(reset.value) - DateTime.toEpochMillis(now)),
      );
    }
    if (failure.retryAfterMs !== undefined) return Math.min(HOUR, failure.retryAfterMs);
  }
  return BOUNDED_DELAYS[kind][attempt - 1]!;
}

/** Only model work resets a streak; provider status, retries and user input do not. */
export function recoveryStreakAfterItem(
  streak: RunRecoveryStreak | null,
  item: Pick<OrchestrationV2TurnItem, "type">,
): RunRecoveryStreak | null {
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
    case "proposed_plan":
    case "todo_list":
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
    case "user_input_request":
      return null;
    default:
      return streak;
  }
}

/** Resolve these facts from the authoritative Run/thread/turn under the dispatch lock. */
export interface RunRecoveryEligibility {
  readonly runStatus: OrchestrationV2Run["status"];
  readonly isRootTurn: boolean;
  readonly isNativeSubagentTurn: boolean;
  readonly isMaintenanceCommand: boolean;
  readonly threadArchived: boolean;
  readonly threadDeleted: boolean;
  readonly interruptRequested: boolean;
  readonly messageDelivery: NonNullable<OrchestrationV2ConversationMessage["delivery"]>;
  readonly hasNewerUserWork: boolean;
  readonly providerSelectionChanged: boolean;
}

export function isRunRecoveryEligible(input: RunRecoveryEligibility): boolean {
  return (
    (input.runStatus === "running" || input.runStatus === "starting") &&
    input.isRootTurn &&
    !input.isNativeSubagentTurn &&
    !input.isMaintenanceCommand &&
    !input.threadArchived &&
    !input.threadDeleted &&
    !input.interruptRequested &&
    input.messageDelivery !== "unknown" &&
    !input.hasNewerUserWork &&
    !input.providerSelectionChanged
  );
}
