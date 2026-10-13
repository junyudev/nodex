import { ProviderSessionId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { HostBridge } from "./HostBridge.ts";
import type { AgentThreadAuthority } from "./Interface.ts";

export const make = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const bridge = yield* HostBridge;
  return Effect.fn("AgentRuntime.readThreadAuthority")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const shell = yield* projections.getThreadShell(input.threadId);
    if (shell === null || shell.activeRunId !== input.runId) return null;
    const state = yield* projections.getHostToolAuthorityContext(input.threadId, input.runId);
    const run = state.runs[0];
    if (
      run === undefined ||
      run.id !== input.runId ||
      run.activeAttemptId === null ||
      state.thread.deletedAt !== null
    )
      return null;
    const nativeThread = state.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    if (nativeThread?.providerSessionId == null) return null;
    const runtime = yield* sessions.get(ProviderSessionId.make(nativeThread.providerSessionId));
    if (Option.isNone(runtime) || runtime.value.nativeGeneration === undefined) return null;
    const nativeTurn = state.providerTurns.find(
      (turn) => turn.runAttemptId === run.activeAttemptId,
    );
    const liveBackground =
      runtime.value.hasPendingBackgroundWorkForThread?.(nativeThread) ??
      runtime.value.hasPendingBackgroundWork;
    const hasNativeBackgroundWork =
      (nativeThread.pendingBackgroundTasks?.length ?? 0) > 0 ||
      state.subagents.length > 0 ||
      (liveBackground === undefined ? false : yield* liveBackground);
    return {
      runtimeId: bridge.runtimeId,
      runtimeGeneration: bridge.runtimeGeneration,
      projectId: state.thread.projectId,
      threadId: state.thread.id,
      runId: run.id,
      attemptId: run.activeAttemptId,
      rootThreadId: state.thread.lineage.rootThreadId,
      parent:
        state.directParent?.runId == null
          ? null
          : { threadId: state.directParent.threadId, runId: state.directParent.runId },
      runtimeMode: state.thread.runtimeMode,
      interactionMode: state.thread.interactionMode,
      status: run.status,
      readOnly: state.thread.interactionMode === "plan",
      archived: state.thread.archivedAt !== null,
      providerInstanceId: run.providerInstanceId,
      providerSessionId: nativeThread.providerSessionId,
      providerThreadId: nativeThread.id,
      nativeGeneration: runtime.value.nativeGeneration,
      nativeThreadRef: nativeThread.nativeThreadRef,
      nativeTurnId: nativeTurn?.nativeTurnRef?.nativeId ?? null,
      cwd: runtime.value.providerSession.cwd,
      hasNativeBackgroundWork,
    } satisfies AgentThreadAuthority;
  });
});
