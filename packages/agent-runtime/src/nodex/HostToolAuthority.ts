import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import type { AgentHostTurnIdentity } from "./Interface.ts";

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
      | "id"
      | "providerSessionId"
      | "providerInstanceId"
      | "nativeThreadRef"
      | "pendingBackgroundTasks"
    >
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "status" | "providerThreadId">
  >;
}

/** Session credentials identify a thread; only the exact admitted foreground Run may act. */
export function hostToolAuthorityRefusal(
  state: HostToolAuthorityView,
  prepared: AgentHostTurnIdentity,
  nativeGeneration: number | undefined,
): string | undefined {
  if (
    state.thread.deletedAt !== null ||
    state.thread.id !== prepared.threadId ||
    state.thread.projectId !== prepared.projectId
  ) {
    return "Thread authority is no longer valid.";
  }
  if (nativeGeneration !== prepared.nativeGeneration) return "Native session generation changed.";
  const activeRun = state.runs.reduce<HostToolAuthorityView["runs"][number] | undefined>(
    (active, run) =>
      run.status === "running" && (active === undefined || run.ordinal > active.ordinal)
        ? run
        : active,
    undefined,
  );
  if (
    activeRun?.id !== prepared.runId ||
    state.thread.activeProviderThreadId !== prepared.providerThreadId
  ) {
    return "The admitted foreground Run is no longer active.";
  }
  const run = activeRun;
  if (
    run?.status !== "running" ||
    run.activeAttemptId !== prepared.attemptId ||
    run.providerThreadId !== prepared.providerThreadId ||
    run.providerInstanceId !== prepared.providerInstanceId
  ) {
    return "The admitted foreground attempt is no longer active.";
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
  if ((nativeThread.pendingBackgroundTasks?.length ?? 0) > 0) {
    return "Native background work makes this tool caller ambiguous.";
  }
  if (
    state.subagents.some(
      (agent) =>
        agent.origin === "provider_native" &&
        agent.providerThreadId === prepared.providerThreadId &&
        ["pending", "running", "waiting"].includes(agent.status),
    )
  ) {
    return "A native child makes this tool caller ambiguous.";
  }
  return undefined;
}
