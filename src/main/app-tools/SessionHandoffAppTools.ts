import {
  captureAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolAuthorityCapture,
} from "./AppToolCaller";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sessionHandoffSchema } from "../../shared/nodex-app-tools/session-handoff-schemas";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";
import { sessionMessageCeilingError } from "./session-message-policy";
import { make as makeControlAuthority, denied } from "./SessionControlAuthority";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { make as makeAppToolOperation } from "./AppToolOperation";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

export const makeWithCapture = (captureCaller: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const admitOperation = yield* makeAppToolOperation;
    const identity = yield* CoreAuthority;
    const core = yield* CoreModules;
    const handoffs = yield* CodexThreadHandoffRuntime;
    const application = yield* Effect.serviceOption(AgentRuntimeApplication);
    const workspace = yield* ProjectWorkspace;
    const access = yield* makeControlAuthority;

    return Effect.fn("SessionHandoffAppTools.execute")(function* (input: AppToolInvocation) {
      const parsed = parseAppToolArguments(sessionHandoffSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* captureCaller(input.caller);
      if (!authority) return toolFailure("authority_unavailable");

      const admitted = yield* admitOperation(
        input,
        authority,
        identity.identity.profileId,
        parsed.data,
      );
      if (!admitted.success) return admitted.result;
      const { operationId } = admitted;
      const { idempotencyKey: _key, ...request } = parsed.data;
      const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
      const observed = yield* core.workspace
        .read(
          { kind: "agent_session", session_id: request.sessionId, provenance },
          { deadlineMs: 10_000 },
          provenance.authority.actor_project_id,
        )
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, { operationId });
      if (!observed || observed.value.kind !== "agent_session")
        return toolFailure("session_unavailable");
      const { thread, session } = observed.value;
      if (session.archived) return toolFailure("session_archived");
      const caller = yield* resolveAppToolCallingSession(input.caller, workspace);
      if (!caller) return toolFailure("session_unavailable");
      if (caller.sessionId === request.sessionId)
        return toolFailure("cannot_handoff_calling_session");
      const callerTarget = {
        sessionId: caller.sessionId,
        ...(readHostedAppToolSessionContext(input.caller)
          ? { execution: { threadId: caller.threadId } }
          : {}),
      };
      const admittedModes = yield* Effect.gen(function* () {
        const source = yield* access.inspect(callerTarget);
        const { facts } = yield* access.check(callerTarget, { sessionId: request.sessionId });
        const error = facts ? sessionMessageCeilingError(source, facts) : null;
        if (error) return yield* denied(error);
        return { runtimeMode: source.runtimeMode, interactionMode: source.interactionMode };
      }).pipe(Effect.provideService(CoreApplicationAgent, provenance), Effect.result);
      if (admittedModes._tag === "Failure")
        return toolFailure(
          typeof admittedModes.failure === "object" &&
            admittedModes.failure !== null &&
            "reason" in admittedModes.failure &&
            typeof admittedModes.failure.reason === "string"
            ? admittedModes.failure.reason
            : "session_unavailable",
        );
      const modeLimit = admittedModes.success;
      if (session.execution_ref) {
        if (Option.isNone(application)) return toolFailure("session_backend_unavailable");
        const hosted = readHostedAppToolSessionContext(input.caller);
        if (hosted?.sessionId === request.sessionId)
          return toolFailure("cannot_handoff_calling_session");
        const target = yield* application.value.inspect({ sessionId: request.sessionId }).pipe(
          Effect.provideService(CoreApplicationAgent, provenance),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        if (!target) return toolFailure("session_unavailable");
        const result = { operationId, sessionId: request.sessionId, threadId: target.threadId };
        const existing = yield* handoffs
          .get(operationId)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const operation = yield* handoffs
          .launch({
            operationId,
            threadId: target.threadId,
            requestThreadId: hosted?.threadId ?? input.caller.threadId,
            threadTitle: target.thread.title,
            destinationHostId: request.destinationHostId ?? null,
            followUpPrompt: request.followUpPrompt ?? null,
            modeLimit,
          })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!operation) return toolFailure("session_handoff_unconfirmed", undefined, result);
        if (operation.sourceThreadId !== target.threadId)
          return toolFailure("handoff_binding_changed", undefined, result);
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        return toolSuccess({
          ...result,
          replay: existing !== null,
          deliveryState: "started",
          operation,
        });
      }
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
          modeLimit,
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!operation)
        return toolFailure("session_handoff_unconfirmed", undefined, {
          ...result,
          committed: true,
        });
      if (operation.sourceThreadId !== thread.thread_id)
        return toolFailure("handoff_binding_changed", undefined, { ...result, committed: true });
      return toolSuccess({ ...result, replay: false, deliveryState: "started", operation });
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
