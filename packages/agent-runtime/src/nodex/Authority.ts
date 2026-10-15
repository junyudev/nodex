import { ProviderSessionId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { HostBridge } from "./HostBridge.ts";
import type { AgentThreadAuthority, AgentNativeSessionAuthority } from "./Interface.ts";

export const make = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const bridge = yield* HostBridge;
  return Effect.fn("AgentRuntime.readThreadAuthority")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const shell = yield* projections.getThreadShell(input.threadId);
    if (shell === null) return null;
    const state = yield* projections.getHostToolAuthorityContext(input.threadId, input.runId);
    const run = state.runs[0];
    if (
      run === undefined ||
      ["cancelled", "interrupted", "rolled_back"].includes(run.status) ||
      run.id !== input.runId ||
      run.activeAttemptId === null ||
      state.thread.deletedAt !== null
    )
      return null;
    const nativeThread = state.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    if (nativeThread?.providerSessionId == null) return null;
    const prepared = yield* bridge.preparedRun(input.threadId, input.runId);
    const runtime = yield* sessions.get(ProviderSessionId.make(nativeThread.providerSessionId));
    const nativeGeneration =
      prepared?.nativeGeneration ??
      (Option.isSome(runtime) ? runtime.value.nativeGeneration : undefined);
    if (nativeGeneration === undefined) return null;
    if (
      prepared !== undefined &&
      !(yield* bridge.nativeSessionLive({
        providerSessionId: nativeThread.providerSessionId,
        nativeGeneration,
      }))
    )
      return null;
    const nativeTurn = state.providerTurns.find(
      (turn) => turn.runAttemptId === run.activeAttemptId,
    );
    const liveBackground = Option.isSome(runtime)
      ? (runtime.value.hasPendingBackgroundWorkForThread?.(nativeThread) ??
        runtime.value.hasPendingBackgroundWork)
      : undefined;
    const hasNativeBackgroundWork =
      nativeThread.hasPendingBackgroundWork ||
      state.subagents.length > 0 ||
      (liveBackground === undefined ? false : yield* liveBackground);
    return {
      runtimeId: bridge.runtimeId,
      runtimeGeneration: bridge.runtimeGeneration,
      projectId: state.thread.projectId,
      threadId: state.thread.id,
      runId: run.id,
      userMessageId: run.userMessageId,
      attemptId: run.activeAttemptId,
      rootThreadId: state.thread.lineage.rootThreadId,
      status: run.status,
      archived: state.thread.archivedAt !== null,
      providerInstanceId: run.providerInstanceId,
      providerSessionId: nativeThread.providerSessionId,
      providerThreadId: nativeThread.id,
      nativeGeneration,
      nativeThreadRef: nativeThread.nativeThreadRef,
      nativeTurnId: nativeTurn?.nativeTurnRef?.nativeId ?? null,
      cwd:
        prepared?.cwd ??
        shell.worktreePath ??
        (Option.isSome(runtime) ? runtime.value.providerSession.cwd : null),
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      hasNativeBackgroundWork,
    } satisfies AgentThreadAuthority;
  });
});

/** Read the real native Session without choosing a causal Run. */
export const makeNativeSession = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const bridge = yield* HostBridge;
  return Effect.fn("AgentRuntime.readNativeSessionAuthority")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly nativeGeneration: number;
    readonly incarnationId: string;
  }) {
    const actor = yield* bridge.nativeSessionActor(input.threadId, input);
    if (actor === undefined) return null;
    const shell = yield* projections.getThreadShell(input.threadId);
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return null;
    const state = yield* projections.getHostToolAuthorityContext(
      input.threadId,
      null,
      actor.providerThreadId,
    );
    const native = state.providerThreads.find(
      (candidate) => candidate.id === actor.providerThreadId,
    );
    if (
      native === undefined ||
      native.providerSessionId !== actor.providerSessionId ||
      native.providerInstanceId !== actor.providerInstanceId ||
      native.nativeThreadRef?.nativeId !== actor.nativeThreadRef?.nativeId ||
      native.nativeThreadRef?.driver !== actor.nativeThreadRef?.driver
    )
      return null;
    return {
      ...actor,
      projectId: shell.projectId,
      rootThreadId: state.thread.lineage.rootThreadId,
      status: null,
      archived: false,
      nativeTurnId: null,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      hasNativeBackgroundWork: native.hasPendingBackgroundWork || state.subagents.length > 0,
    } satisfies AgentNativeSessionAuthority;
  });
});
