import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationV2ContextBudget } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import { NODEX_FAILURE_CODES } from "../failureCause.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Schema from "effect/Schema";

/** Raised when portable history does not fit the target provider's context window. */
export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  { budget: Schema.optional(OrchestrationV2ContextBudget) },
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;
export const MAX_PROVIDER_FAILURE_DIAGNOSTIC_LENGTH = 2_000;

/** Render the bounded error chain, never stacks or arbitrary serialized payloads. */
export function providerFailureDiagnostic(cause: unknown, message?: string): string | undefined {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause === "string") {
        if (boundedText(cause, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH) !== message) parts.push(cause);
        break;
      }
      if (typeof cause !== "object") break;
      const error = cause as {
        _tag?: unknown;
        name?: unknown;
        message?: unknown;
        cause?: unknown;
        reason?: unknown;
      };
      const name = typeof error._tag === "string" ? error._tag : error.name;
      if (
        typeof error.message === "string" &&
        boundedText(error.message, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH) !== message
      )
        parts.push(`${typeof name === "string" ? `${name}: ` : ""}${error.message}`);
      cause = error.cause ?? error.reason;
    } catch {
      break;
    }
  }
  return parts.length === 0
    ? undefined
    : boundedText(parts.join(" → "), MAX_PROVIDER_FAILURE_DIAGNOSTIC_LENGTH);
}

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

/** A context-budget refusal can arrive wrapped in Causes or nested errors; foreign accessors may throw. */
function findContextBudgetError(cause: unknown): ContextHandoffBudgetError | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  try {
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      if (Cause.isCause(current)) current = Cause.squash(current);
      else if (Schema.is(ContextHandoffBudgetError)(current)) return current;
      else current = (current as { cause?: unknown }).cause;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A known error category: its user-facing message and, when Nodex observed it itself, its code. */
interface KnownCause {
  readonly retryable?: boolean;
  readonly message?: string | undefined;
  readonly code?: string | undefined;
}

/** Translate known categories without exposing arbitrary provider defect text. */
function knownCause(cause: unknown): KnownCause {
  const seen = new Set<unknown>();
  let known: KnownCause = {};
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      switch ((cause as Record<string, unknown>)._tag) {
        case "ModelPolicyError":
          return { message: stringField(cause, "message"), code: stringField(cause, "code"), retryable: false };
        case "ContextHandoffBudgetError":
          return { message: new ContextHandoffBudgetError().message };
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
          return {
            message: stringField(cause, "message"),
            code: NODEX_FAILURE_CODES.backgroundWorkBlocks,
          };
        case "ContextHandoffDeliveryUncertainError":
          return {
            message:
              "Nodex could not confirm whether the conversation history reached the Agent. Retry the turn to recover the session.",
            code: NODEX_FAILURE_CODES.deliveryUncertain,
          };
        case "ProviderTurnOwnershipConflictError":
          return {
            message: stringField(cause, "message"),
            code: NODEX_FAILURE_CODES.turnOwnershipConflict,
          };
        case "ProviderAdapterTurnStartError":
          known = {
            message:
              "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
          };
          break;
        // A provider client's own transport report that its process is gone.
        case "CodexAppServerProcessExitedError":
        case "CodexAppServerInputStreamEndedError":
        case "AcpProcessExitedError":
        case "AcpInputStreamEndedError":
          known = {
            message: "The Agent stopped before finishing this reply.",
            code: NODEX_FAILURE_CODES.processExited,
          };
          break;
        case "ProviderAdapterEventStreamError":
          known = {
            message: "The Agent's event stream closed before this reply finished.",
            code: NODEX_FAILURE_CODES.eventStreamLost,
          };
          break;
        case "ProviderAdapterOpenSessionError":
          known = {
            message:
              "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
          };
          break;
        case "ProviderAdapterResumeThreadError":
          known = {
            message:
              "The provider conversation could not be resumed. Retry the turn; if it keeps failing, check the provider and server logs.",
          };
          break;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return known;
}

function stringField(value: unknown, key: "message" | "code"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

/** Removes common credential forms before provider text crosses a transport boundary. */
function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null | undefined;
  readonly resetAt?: string | null | undefined;
  readonly httpStatusCode?: number | null;
  readonly retryAfterMs?: number | null;
}): OrchestrationV2ProviderFailure {
  const budgetError = findContextBudgetError(input.cause);
  const budgetExhausted = budgetError !== undefined;
  const contextBudget = budgetError?.budget;
  const known = knownCause(input.cause);
  const rawMessage = input.message ?? known.message ?? DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const diagnostic = providerFailureDiagnostic(input.cause, message);
  const rawCode = budgetExhausted
    ? "context_budget_exhausted"
    : (input.code ?? stringField(input.cause, "code") ?? known.code ?? null);
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    ...(diagnostic === undefined ? {} : { diagnostic }),
    class: input.class ?? "unknown",
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: budgetExhausted ? false : (known.retryable ?? input.retryable ?? null),
    ...(contextBudget === undefined ? {} : { contextBudget }),
    ...(Number.isInteger(input.httpStatusCode) && input.httpStatusCode! >= 100 && input.httpStatusCode! <= 599
      ? { httpStatusCode: input.httpStatusCode! } : {}),
    ...(Number.isInteger(input.retryAfterMs) && input.retryAfterMs! >= 0
      ? { retryAfterMs: input.retryAfterMs! } : {}),
    ...(input.resetAt != null &&
    Number.isFinite(Date.parse(input.resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.resetAt)) }
      : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
