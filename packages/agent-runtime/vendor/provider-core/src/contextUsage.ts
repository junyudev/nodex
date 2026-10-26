import type { OrchestrationV2ProviderTurn, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

// A structural read boundary shared by domain and wire projections. Identity strings
// are unbranded here; the runtime validates them before publishing either projection.
interface NativeContextUsageProjection<Selection> {
  readonly providerTurns: readonly (Pick<OrchestrationV2ProviderTurn, "tokenUsage" | "ordinal"> & {
    readonly id: string;
    readonly providerThreadId: string;
    readonly runAttemptId: string | null;
    readonly nodeId: string;
  })[];
  readonly attempts: readonly {
    readonly id: string;
    readonly runId: string;
    readonly providerThreadId: string;
    readonly rootNodeId: string;
    readonly nativeThreadId?: string | null | undefined;
  }[];
  readonly runs: readonly {
    readonly id: string;
    readonly modelSelection: Selection;
    readonly status?: string | undefined;
  }[];
}
interface NativeContextUsageThread {
  readonly id: string;
  readonly nativeThreadRef: { readonly nativeId: string | null } | null;
}

// Live reports belong to provider turns. Use only accepted root attempts whose
// durable native identity matches this thread; row reuse must not revive old usage.
export function latestNativeContextUsage<Selection>(
  projection: NativeContextUsageProjection<Selection>,
  providerThread: NativeContextUsageThread,
) {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId == null) return undefined;
  const attempts = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  let latest:
    | {
        usage: ThreadTokenUsageSnapshot;
        modelSelection: Selection;
        providerTurnId: string;
        attemptId: string;
        runId: string;
        ordinal: number;
        reportedAt: string;
      }
    | undefined;
  for (const turn of projection.providerTurns) {
    if (
      turn.providerThreadId !== providerThread.id ||
      turn.runAttemptId === null ||
      !turn.tokenUsage
    )
      continue;
    const attempt = attempts.get(turn.runAttemptId);
    if (
      attempt?.nativeThreadId !== nativeId ||
      attempt.providerThreadId !== providerThread.id ||
      attempt.rootNodeId !== turn.nodeId
    )
      continue;
    const run = runs.get(attempt.runId);
    if (!run || run.status === "rolled_back") continue;
    if (
      latest &&
      (latest.reportedAt > turn.tokenUsage.updatedAt ||
        (latest.reportedAt === turn.tokenUsage.updatedAt && latest.ordinal >= turn.ordinal))
    ) continue;
    latest = {
      usage: {
        usedTokens: turn.tokenUsage.usedTokens,
        ...(turn.tokenUsage.maxTokens != null && turn.tokenUsage.maxTokens > 0
          ? { maxTokens: turn.tokenUsage.maxTokens }
          : {}),
      },
      modelSelection: run.modelSelection,
      reportedAt: turn.tokenUsage.updatedAt,
      providerTurnId: turn.id,
      attemptId: attempt.id,
      runId: run.id,
      ordinal: turn.ordinal,
    };
  }
  return latest;
}

/** A queued reservation cannot select the active native conversation. */
export function providerThreadActivatesThread(
  provider: {
    readonly appThreadId: string | null;
    readonly status: string;
    readonly firstRunOrdinal: number | null;
    readonly nativeThreadRef: unknown;
    readonly providerSessionId: string | null;
  },
  threadId: string,
): boolean {
  if (provider.appThreadId !== threadId || provider.status === "closed") return false;
  return !(
    provider.status === "not_loaded" &&
    provider.firstRunOrdinal === null &&
    provider.nativeThreadRef === null &&
    provider.providerSessionId === null
  );
}
