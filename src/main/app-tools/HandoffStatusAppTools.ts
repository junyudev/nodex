import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { handoffStatusSchema } from "../../shared/nodex-app-tools/session-handoff-schemas";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const makeWithCapture = (captureCaller: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const identity = yield* CoreAuthority;
    const core = yield* CoreModules;
    const handoffs = yield* CodexThreadHandoffRuntime;
    const application = yield* Effect.serviceOption(AgentRuntimeApplication);
    return Effect.fn("HandoffStatusAppTools.execute")(function* (input: AppToolInvocation) {
      const parsed = handoffStatusSchema.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* captureCaller(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
      const { sessionId, operationId, afterRevision, waitMs } = parsed.data;
      const readBinding = core.workspace
        .read(
          { kind: "agent_session", session_id: sessionId, provenance },
          { deadlineMs: 10_000 },
          provenance.authority.actor_project_id,
        )
        .pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result.value.kind !== "agent_session") return null;
              const { session, thread } = result.value;
              if (!session.execution_ref)
                return thread?.backend_binding.kind === "codex" ? thread.thread_id : null;
              if (Option.isNone(application)) return null;
              const target = yield* application.value
                .inspect({ sessionId })
                .pipe(Effect.provideService(CoreApplicationAgent, provenance));
              return target.threadId;
            }),
          ),
          Effect.catch(() => Effect.succeed(null)),
        );
      const threadId = yield* readBinding;
      if (!threadId) return toolFailure("session_unavailable");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const initial = yield* handoffs
        .get(operationId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!initial || initial.sourceThreadId !== threadId)
        return toolFailure("handoff_unavailable");
      const operation = yield* handoffs
        .waitForRevision(operationId, afterRevision ?? null, waitMs)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const currentThreadId = yield* readBinding;
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      if (
        !currentThreadId ||
        currentThreadId !== threadId ||
        operation?.sourceThreadId !== threadId
      )
        return toolFailure("handoff_unavailable");
      return toolSuccess({ sessionId, operationId, operation });
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
