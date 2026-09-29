import { captureAppToolAuthority } from "./AppToolCaller";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import {
  CodexTurnCommands,
  type CodexTurnCommandsError,
} from "../codex-application/CodexTurnCommands";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createStableOperationId } from "../core-runtime/operation-identity";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { NativeConversationExtension } from "./NativeConversationExtension";

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;
  const core = yield* CoreModules;
  const commands = yield* CodexTurnCommands;
  const native = yield* Effect.serviceOption(NativeConversationExtension);

  return Effect.fn("SessionMessageAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = sessionMessageSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* captureAppToolAuthority(input.caller, turns);
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    const { operationId: suppliedOperationId, ...request } = parsed.data;
    const operationId =
      suppliedOperationId ??
      createStableOperationId("app.send_message_to_session", authority.frozenAtMs, [
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
    if (
      !thread ||
      (thread.backend_binding.kind !== "codex" && thread.backend_binding.kind !== "claude")
    )
      return toolFailure("session_backend_unavailable");
    if (thread.backend_binding.kind === "claude" && Option.isNone(native))
      return toolFailure("session_backend_unavailable");
    if (thread.thread_id === input.caller.threadId)
      return toolFailure("cannot_message_calling_session");
    if (thread.backend_binding.kind === "claude" && Option.isSome(native)) {
      const target = yield* native.value
        .read(thread.thread_id)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!target || target.archived) return toolFailure("session_unavailable");
      if (target.busy) return toolFailure("session_busy");
    }
    const admission = yield* core.workspace
      .apply(
        {
          operationId,
          intent: {
            kind: "agent_command",
            provenance,
            intent: {
              kind: "admit_session_message",
              session_id: request.sessionId,
              thread_id: thread.thread_id,
              message_request_hash: createHash("sha256")
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
      return toolFailure("session_message_admission_failed", undefined, { operationId });
    const result = { operationId, sessionId: request.sessionId, threadId: thread.thread_id };
    if (!input.caller.isActive())
      return toolFailure("call_withdrawn", undefined, { ...result, committed: true });
    if (admission.receipt.duplicate)
      return toolSuccess({ ...result, replay: true, deliveryState: "unconfirmed" });
    if (!admission.receipt.affected_session_ids.includes(request.sessionId))
      return toolFailure("session_message_unconfirmed", undefined, result);
    const dispatch: Effect.Effect<
      { readonly turnId: string | null } | null,
      Error | CodexTurnCommandsError
    > =
      thread.backend_binding.kind === "claude" && Option.isSome(native)
        ? native.value.submit({
            threadId: thread.thread_id,
            prompt: request.prompt,
            operationId,
            ...(request.model ? { model: request.model } : {}),
          })
        : commands.start(thread.thread_id, request.prompt, {
            ...(request.model ? { model: request.model } : {}),
            clientUserMessageId: operationId,
          });
    return yield* dispatch.pipe(
      Effect.map((turn) =>
        turn?.turnId
          ? toolSuccess({
              ...result,
              replay: false,
              deliveryState: "started",
              turnId: turn.turnId,
            })
          : toolFailure("session_message_unconfirmed", undefined, { ...result, committed: true }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          toolFailure(
            "session_message_unconfirmed",
            "Message dispatch was reserved, but delivery is unconfirmed. Retry with the same operationId and arguments; it will not send again. Read the Session to inspect its history.",
            { ...result, committed: true },
          ),
        ),
      ),
    );
  });
});
