import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2RunRecovery,
  OrchestrationV2RunRecoveryKind,
  OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import { providerFailureCause } from "@nodex/provider-core/failureCause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type RunRecoveryKind = OrchestrationV2RunRecoveryKind | "none";

/** Retain across attempts (and failure-kind changes), until model output or Run settlement. */
export type RunRecoveryStreak = Pick<OrchestrationV2RunRecovery, "streakStartedAt" | "attempt">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CONNECTION_DELAYS = [5_000, 10_000, 20_000, 40_000, MINUTE];
/**
 * Bounded schedules. A busy service is retried for about an hour, because capacity
 * incidents outlast a few minutes and unattended work should outlast them too.
 */
const BOUNDED_DELAYS = {
  overloaded: [10_000, 30_000, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  rate_limit: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE],
  process_lost: [5_000, 30_000, 2 * MINUTE, 10 * MINUTE],
} as const;

/**
 * Whether a failed reply may continue on its own: only a cause the evidence names as
 * transient. An unexplained failure ends the reply, so a delegating Agent or the user
 * decides with the cause in hand instead of waiting on blind retries.
 */
export function classifyRunRecovery(failure: OrchestrationV2ProviderFailure): RunRecoveryKind {
  if (failure.retryable === false) return "none";
  const cause = providerFailureCause(failure);
  switch (cause) {
    case "connection":
    case "overloaded":
    case "rate_limit":
    case "process_lost":
      return cause;
    case "unknown":
    case "usage_limit":
    case "authentication":
    case "context_budget":
    case "refused":
    case "unrecoverable":
      return "none";
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
