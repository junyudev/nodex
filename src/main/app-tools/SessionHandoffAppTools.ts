import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { sessionHandoffSchema } from "../../shared/nodex-app-tools/session-handoff-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
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
  const handoffs = yield* CodexThreadHandoffRuntime;

  return Effect.fn("SessionHandoffAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = sessionHandoffSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    const { operationId: suppliedOperationId, ...request } = parsed.data;
    const operationId =
      suppliedOperationId ??
      createStableOperationId("app.handoff_session", authority.frozenAtMs, [
        identity.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
    const observed = yield* core.workspace
      .read(
        { kind: "agent_session", session_id: request.sessionId, provenance },
        { deadlineMs: 10_000 },
        provenance.authority.actor_project_id,
      )
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!input.caller.isActive()) return toolFailure("call_withdrawn", undefined, { operationId });
    if (!observed || observed.value.kind !== "agent_session")
      return toolFailure("session_unavailable");
    const { thread, session } = observed.value;
    if (session.archived) return toolFailure("session_archived");
    if (!thread || thread.backend_binding.kind !== "codex")
      return toolFailure("session_backend_unavailable");
    if (thread.thread_id === input.caller.threadId)
      return toolFailure("cannot_handoff_calling_session");
    const admission = yield* core.workspace
      .apply(
        {
          operationId,
          intent: {
            kind: "agent_command",
            provenance,
            intent: {
              kind: "admit_session_handoff",
              session_id: request.sessionId,
              thread_id: thread.thread_id,
              handoff_request_hash: createHash("sha256")
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
      return toolFailure("session_handoff_admission_failed", undefined, { operationId });
    const result = { operationId, sessionId: request.sessionId, threadId: thread.thread_id };
    if (!input.caller.isActive())
      return toolFailure("call_withdrawn", undefined, { ...result, committed: true });
    if (admission.receipt.duplicate) {
      const operation = yield* handoffs
        .get(operationId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (operation && operation.sourceThreadId !== thread.thread_id)
        return toolFailure("handoff_binding_changed", undefined, result);
      return toolSuccess({
        ...result,
        replay: true,
        operation,
        deliveryState: operation ? "started" : "unconfirmed",
      });
    }
    if (!admission.receipt.affected_session_ids.includes(request.sessionId))
      return toolFailure("session_handoff_unconfirmed", undefined, result);
    const operation = yield* handoffs
      .launch({
        operationId,
        threadId: thread.thread_id,
        requestThreadId: input.caller.threadId,
        threadTitle: session.display_title,
        destinationHostId: request.destinationHostId ?? null,
        followUpPrompt: request.followUpPrompt ?? null,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!operation)
      return toolFailure("session_handoff_unconfirmed", undefined, { ...result, committed: true });
    if (operation.sourceThreadId !== thread.thread_id)
      return toolFailure("handoff_binding_changed", undefined, { ...result, committed: true });
    return toolSuccess({ ...result, replay: false, deliveryState: "started", operation });
  });
});
