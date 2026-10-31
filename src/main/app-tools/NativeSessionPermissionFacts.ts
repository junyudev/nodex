import * as Effect from "effect/Effect";
import { SessionMessageIntakeError } from "./SessionMessageIntakeError";
import type { CodexCanonicalPermissionContext } from "../../shared/types";
import type { SessionExecutionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import type { SessionMessageFacts } from "./session-message-policy";
export interface NativeFacts extends SessionMessageFacts {
  readonly threadId: string;
  readonly executionHostId: string;
  readonly permissions: CodexCanonicalPermissionContext;
}
/** Read concrete native permission facts without resuming or replacing its execution owner. */
export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const directory = yield* CodexThreadDirectory;
  const resolve = Effect.fn("NativeSessionPermissionFacts.resolve")(function* (
    target: SessionExecutionTarget,
  ) {
    const session = yield* workspace.getProjectSession(target.sessionId);
    if (
      !session ||
      session.archived ||
      session.executionRef ||
      session.thread?.backendBinding.kind !== "codex"
    )
      return yield* new SessionMessageIntakeError({ message: "Native Session is unavailable" });
    const threadId = session.thread.threadId;
    if (target.execution)
      return yield* new SessionMessageIntakeError({
        message: "Native execution is outside this Session",
      });
    return { session, thread: session.thread, threadId };
  });
  const inspect = Effect.fn("NativeSessionPermissionFacts.inspect")(function* (
    target: SessionExecutionTarget,
  ): Effect.fn.Return<NativeFacts, unknown> {
    const { session, thread, threadId } = yield* resolve(target);
    const entry = yield* directory.resolve({
      threadId,
      fidelity: "durable",
      expectedHostId: thread.executionHostId,
    });
    const state = entry?.canonical;
    const permissions = state?.currentPermissions;
    const settings = state?.latestThreadSettings ?? state?.hydrationContext?.latestThreadSettings;
    if (
      !state ||
      state.hostId !== thread.executionHostId ||
      !permissions ||
      !settings?.model ||
      !settings.collaborationMode ||
      !settings.approvalPolicy ||
      !settings.sandboxPolicy
    )
      return yield* new SessionMessageIntakeError({
        message: "Native execution permission facts are unavailable",
      });
    const runtimeMode =
      permissions.sandboxPolicy.type === "dangerFullAccess"
        ? ("full-access" as const)
        : permissions.sandboxPolicy.type === "workspaceWrite"
          ? permissions.approvalPolicy === "never"
            ? ("auto-accept-edits" as const)
            : ("approval-required" as const)
          : permissions.sandboxPolicy.type === "readOnly"
            ? ("approval-required" as const)
            : null;
    if (runtimeMode === null)
      return yield* new SessionMessageIntakeError({
        message: "Native execution permissions cannot be compared",
      });
    return {
      sessionId: session.id,
      threadId,
      executionHostId: thread.executionHostId,
      permissions,
      runtimeMode,
      nativeSandbox: permissions.sandboxPolicy.type as
        | "readOnly"
        | "workspaceWrite"
        | "dangerFullAccess",
      nativePermissions: permissions,
      interactionMode: settings.collaborationMode.mode === "plan" ? "plan" : "default",
      modelSelection: {
        instanceId: "codex",
        model: settings.model,
        options: state.latestReasoningEffort
          ? [{ id: "reasoningEffort", value: state.latestReasoningEffort }]
          : [],
      },
    };
  });
  return { resolve, inspect };
});
