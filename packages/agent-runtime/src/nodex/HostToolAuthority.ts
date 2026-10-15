import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import type { AgentHostExecutionIdentity } from "./Interface.ts";

export interface HostToolAuthorityView {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "projectId" | "activeProviderThreadId" | "deletedAt"
  >;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "activeAttemptId" | "providerThreadId" | "providerInstanceId" | "status"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderThread,
      "id" | "providerSessionId" | "providerInstanceId" | "nativeThreadRef"
    >
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "status" | "providerThreadId">
  >;
}

/** Validate the captured execution route and cancellation lifetime, without resource access policy. */
export function hostToolAuthorityRefusal(
  state: HostToolAuthorityView,
  prepared: AgentHostExecutionIdentity,
  nativeGeneration: number | undefined,
): string | undefined {
  if (state.thread.deletedAt !== null || state.thread.id !== prepared.threadId) {
    return "Thread authority is no longer valid.";
  }
  if (nativeGeneration !== prepared.nativeGeneration) return "Native session generation changed.";
  const run = state.runs.find((candidate) => candidate.id === prepared.runId);
  if (
    prepared.runId !== null &&
    (run === undefined ||
      ["cancelled", "interrupted", "rolled_back"].includes(run.status) ||
      run.activeAttemptId !== prepared.attemptId ||
      run.providerThreadId !== prepared.providerThreadId ||
      run.providerInstanceId !== prepared.providerInstanceId)
  ) {
    return "The captured execution was cancelled or replaced.";
  }
  const nativeThread = state.providerThreads.find(
    (candidate) => candidate.id === prepared.providerThreadId,
  );
  if (
    nativeThread === undefined ||
    nativeThread.providerSessionId !== prepared.providerSessionId ||
    nativeThread.providerInstanceId !== prepared.providerInstanceId ||
    nativeThread.nativeThreadRef?.nativeId !== prepared.nativeThreadRef?.nativeId ||
    nativeThread.nativeThreadRef?.driver !== prepared.nativeThreadRef?.driver
  ) {
    return "Native thread identity changed.";
  }
  return undefined;
}
