import type { Draft } from "immer";
import type { CodexErrorInfo, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  codexConversationRecoveryReason,
  parseConversationRetryProgress,
  type ConversationRecovery,
} from "../conversation-recovery";
import type {
  CodexCanonicalItem,
  CodexCanonicalTurnErrorItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

export function codexRecoveryFromError(input: {
  readonly message: string;
  readonly errorInfo: CodexErrorInfo | null;
  readonly willRetry: boolean;
  readonly updatedAt: number | null;
  readonly previous?: ConversationRecovery;
}): ConversationRecovery {
  const progress = parseConversationRetryProgress(input.message);
  const reason = codexConversationRecoveryReason(input.errorInfo);
  return {
    state: input.willRetry ? "retrying" : "failed",
    reason: input.errorInfo === null ? (input.previous?.reason ?? reason) : reason,
    attempt: progress?.attempt ?? input.previous?.attempt ?? null,
    maxAttempts: progress?.maxAttempts ?? input.previous?.maxAttempts ?? null,
    retryAt: null,
    updatedAt: input.updatedAt,
  };
}

function activeRecovery(items: readonly Draft<CodexCanonicalItem>[]) {
  return items.findLast(
    (item): item is Draft<CodexCanonicalTurnErrorItem> =>
      item.type === "error" && item.recovery.state === "retrying",
  );
}

/** Retry notifications update one occurrence until model output or a terminal settles it. */
export function mutateCodexProviderError(
  items: Draft<CodexCanonicalItem>[],
  input: {
    readonly id: string;
    readonly message: string;
    readonly errorInfo: CodexErrorInfo | null;
    readonly additionalDetails: string | null;
    readonly willRetry: boolean;
    readonly updatedAt: number;
  },
): void {
  const existing = activeRecovery(items);
  const item: CodexCanonicalTurnErrorItem = {
    id: existing?.id ?? input.id,
    type: "error",
    message: input.message,
    errorInfo: input.errorInfo,
    additionalDetails: input.additionalDetails,
    recovery: codexRecoveryFromError({ ...input, previous: existing?.recovery }),
  };
  if (!existing) {
    items.push(item as Draft<CodexCanonicalTurnErrorItem>);
    return;
  }
  Object.assign(existing, item);
}

/** Local command output and completion do not prove the upstream response stream recovered. */
export function isCodexRecoveryModelOutput(item: ThreadItem): boolean {
  if (item.type === "commandExecution")
    return item.source === "agent" || item.source === "unifiedExecStartup";
  if (item.type === "collabAgentToolCall") return item.tool !== "sendInput";
  return (
    item.type === "agentMessage" ||
    item.type === "reasoning" ||
    item.type === "plan" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "webSearch" ||
    item.type === "imageGeneration"
  );
}

export function recoverCodexProviderRetry(
  items: Draft<CodexCanonicalItem>[],
  now: () => number,
): boolean {
  const existing = activeRecovery(items);
  if (!existing) return false;
  existing.recovery = {
    ...existing.recovery,
    state: "recovered",
    retryAt: null,
    updatedAt: now(),
  };
  return true;
}

/** A terminal settles pending recovery even when the provider sends no final error notification. */
export function settleCodexProviderRecovery(
  turn: Draft<CodexCanonicalTurnState>,
  terminal: Pick<Turn, "status" | "error">,
  updatedAt: number | null,
): void {
  if (terminal.status === "inProgress") return;
  const active = activeRecovery(turn.items);
  if (terminal.status !== "failed") {
    if (!active) return;
    active.recovery = {
      ...active.recovery,
      state: terminal.status === "completed" ? "recovered" : "stopped",
      retryAt: null,
      updatedAt,
    };
    return;
  }
  const error = terminal.error;
  const hydratedErrorId = `error:${turn.turnId}`;
  const existing =
    active ??
    turn.items.findLast(
      (item): item is Draft<CodexCanonicalTurnErrorItem> =>
        item.type === "error" && item.recovery.state === "failed" && item.id !== hydratedErrorId,
    ) ??
    turn.items.findLast(
      (item): item is Draft<CodexCanonicalTurnErrorItem> =>
        item.type === "error" && item.recovery.state === "failed",
    );
  if (!existing && !error) return;
  const message = error?.message ?? existing!.message;
  const errorInfo = error?.codexErrorInfo ?? existing?.errorInfo ?? null;
  const item: CodexCanonicalTurnErrorItem = {
    id: existing?.id ?? hydratedErrorId,
    type: "error",
    message,
    errorInfo,
    additionalDetails: error?.additionalDetails ?? existing?.additionalDetails ?? null,
    recovery: codexRecoveryFromError({
      message,
      errorInfo,
      willRetry: false,
      updatedAt,
      previous: existing?.recovery,
    }),
  };
  if (existing) Object.assign(existing, item);
  else turn.items.push(item as Draft<CodexCanonicalTurnErrorItem>);
  // A hydrated terminal may also carry the synthetic error already represented by a live retry.
  if (item.id !== hydratedErrorId)
    turn.items = turn.items.filter((candidate) => candidate.id !== hydratedErrorId);
}
