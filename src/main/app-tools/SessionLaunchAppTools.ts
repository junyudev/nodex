import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { createSessionSchema } from "../../shared/nodex-app-tools/session-launch-schema";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import { CodexSessionThreadLaunch } from "../codex-application/CodexSessionThreadLaunch";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { createCodexProjectlessWorkspace } from "../codex/codex-projectless-workspace";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;
  const core = yield* CoreModules;
  const launches = yield* CodexSessionThreadLaunch;

  return Effect.fn("SessionLaunchAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = createSessionSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const { operationId: suppliedOperationId, ...request } = parsed.data;
    const operationId =
      suppliedOperationId ??
      createStableOperationId("app.create_session", authority.frozenAtMs, [
        identity.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const sessionId = deriveSessionDispatchIdentity(operationId, "session");
    const projectId = request.target.type === "project" ? request.target.projectId : null;
    const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
    const admission = yield* core.workspace
      .apply(
        {
          operationId,
          intent: {
            kind: "agent_command",
            provenance,
            intent: {
              kind: "admit_session_launch",
              session_id: sessionId,
              project_id: projectId,
              title: request.title ?? "New chat",
              launch_request_hash: createHash("sha256")
                .update(JSON.stringify(request))
                .digest("hex"),
            },
          },
        },
        undefined,
        provenance.authority.actor_project_id,
      )
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!admission)
      return toolFailure("session_launch_admission_failed", undefined, { operationId });
    if (!input.caller.isActive())
      return toolFailure("call_withdrawn", undefined, { operationId, sessionId, committed: true });

    if (admission.receipt.duplicate) {
      const observed = yield* core.workspace
        .read(
          { kind: "agent_session", session_id: sessionId, provenance },
          { deadlineMs: 10_000 },
          provenance.authority.actor_project_id,
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, {
          operationId,
          sessionId,
          committed: true,
        });
      if (!observed || observed.value.kind !== "agent_session")
        return toolFailure("session_unavailable", undefined, {
          operationId,
          sessionId,
          committed: true,
        });
      return toolSuccess({
        operationId,
        sessionId,
        projectId,
        replay: true,
        launchState: observed.value.thread ? "attached" : "unconfirmed",
        threadId: observed.value.thread?.thread_id ?? null,
      });
    }
    if (
      admission.status !== "committed" ||
      !admission.receipt.affected_session_ids.includes(sessionId)
    )
      return toolFailure("session_launch_unconfirmed", undefined, {
        operationId,
        sessionId,
        launchState: "unconfirmed",
      });

    return yield* Effect.gen(function* () {
      const target = request.target;
      const projectlessWorkspace =
        target.type === "projectless"
          ? yield* Effect.tryPromise(() =>
              createCodexProjectlessWorkspace({
                createSplitDirectories: true,
                directoryName: target.directoryName,
                prompt: request.prompt,
              }),
            )
          : undefined;
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, {
          operationId,
          sessionId,
          committed: true,
        });
      const launch = yield* launches.start(
        {
          sessionId,
          projectId,
          prompt: request.prompt,
          threadName: request.title,
          model: request.model,
          projectlessWorkspace,
          // A separately created Session is visible work, not a hidden parentless helper.
          threadSource: "user",
          firstSubmission: {
            launchId: deriveSessionDispatchIdentity(operationId, "launch"),
            clientUserMessageId: deriveSessionDispatchIdentity(operationId, "message"),
          },
          runInTarget:
            target.type === "project" && target.environment.type === "worktree"
              ? "newWorktree"
              : "localProject",
          ...(target.type === "project" && target.environment.type === "worktree"
            ? { worktreeStartingState: target.environment.startingState }
            : {}),
        },
        { browserViewScopeId: "nodex-app-mcp", ownerClientId: null },
      );
      return toolSuccess({
        operationId,
        sessionId,
        projectId,
        replay: false,
        ...(launch.kind === "pending"
          ? {
              launchState: "pending",
              pendingWorktreeId: launch.pendingWorktreeId,
              clientThreadId: launch.clientThreadId,
            }
          : { launchState: "started", threadId: launch.detail.threadId }),
        ...(projectlessWorkspace ? { outputDirectory: projectlessWorkspace.outputDirectory } : {}),
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          toolFailure(
            "session_launch_unconfirmed",
            "Session creation committed, but launch completion is unconfirmed. Retry with the same operationId and arguments to inspect its binding; retry does not launch again.",
            { operationId, sessionId, committed: true, launchState: "unconfirmed" },
          ),
        ),
      ),
    );
  });
});
