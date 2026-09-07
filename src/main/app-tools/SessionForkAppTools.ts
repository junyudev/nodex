import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { sessionForkSchema } from "../../shared/nodex-app-tools/session-fork-schema";
import { CodexProjectSessionFork } from "../codex-application/CodexProjectSessionFork";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;
  const core = yield* CoreModules;
  const workspace = yield* ProjectWorkspace;
  const forks = yield* CodexProjectSessionFork;
  return Effect.fn("SessionForkAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = sessionForkSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    const sourceSessionId =
      parsed.data.sessionId ??
      (yield* workspace
        .getThread(input.caller.threadId)
        .pipe(Effect.catch(() => Effect.succeed(null))))?.sessionId;
    if (!sourceSessionId) return toolFailure("session_unavailable");
    const operationId =
      parsed.data.operationId ??
      createStableOperationId("app.fork_session", authority.frozenAtMs, [
        identity.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const sessionId = deriveSessionDispatchIdentity(operationId, "session");
    const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
    const source = yield* core.workspace
      .read(
        { kind: "agent_session", session_id: sourceSessionId, provenance },
        { deadlineMs: 10_000 },
        provenance.authority.actor_project_id,
      )
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!input.caller.isActive()) return toolFailure("call_withdrawn", undefined, { operationId });
    if (!source || source.value.kind !== "agent_session") return toolFailure("session_unavailable");
    const { thread, session } = source.value;
    if (session.archived) return toolFailure("session_archived");
    if (!thread || thread.backend_binding.kind !== "codex")
      return toolFailure("session_backend_unavailable");
    const admission = yield* core.workspace
      .apply(
        {
          operationId,
          intent: {
            kind: "agent_command",
            provenance,
            intent: {
              kind: "admit_session_fork",
              source_session_id: sourceSessionId,
              source_thread_id: thread.thread_id,
              session_id: sessionId,
              fork_request_hash: createHash("sha256")
                .update(
                  JSON.stringify({
                    sessionId: sourceSessionId,
                    environment: parsed.data.environment,
                  }),
                )
                .digest("hex"),
            },
          },
        },
        undefined,
        provenance.authority.actor_project_id,
      )
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!admission) return toolFailure("session_fork_admission_failed", undefined, { operationId });
    const result = { operationId, sourceSessionId, sessionId };
    if (!input.caller.isActive())
      return toolFailure("call_withdrawn", undefined, { ...result, committed: true });
    if (admission.receipt.duplicate) {
      const destination = yield* core.workspace
        .read(
          { kind: "agent_session", session_id: sessionId, provenance },
          { deadlineMs: 10_000 },
          provenance.authority.actor_project_id,
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, { ...result, committed: true });
      const threadId =
        destination?.value.kind === "agent_session"
          ? (destination.value.thread?.thread_id ?? null)
          : null;
      return toolSuccess({
        ...result,
        replay: true,
        forkState: threadId ? "attached" : "unconfirmed",
        threadId,
      });
    }
    if (
      admission.status !== "committed" ||
      !admission.receipt.affected_session_ids.includes(sessionId)
    )
      return toolFailure("session_fork_unconfirmed", undefined, result);
    return yield* forks
      .fork({
        sessionId: sourceSessionId,
        destinationSessionId: sessionId,
        input: { target: parsed.data.environment.type === "worktree" ? "newWorktree" : "local" },
        threadSource: "user",
      })
      .pipe(
        Effect.map((fork) =>
          toolSuccess({
            ...result,
            replay: false,
            ...("pendingWorktreeId" in fork
              ? {
                  forkState: "pending",
                  pendingWorktreeId: fork.pendingWorktreeId,
                  clientThreadId: fork.clientThreadId,
                }
              : { forkState: "attached", threadId: fork.threadId }),
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(
            toolFailure(
              "session_fork_unconfirmed",
              "The destination Session was reserved, but fork completion is unconfirmed. Retry with the same operationId and arguments to inspect its binding; retry never forks again.",
              { ...result, committed: true },
            ),
          ),
        ),
      );
  });
});
