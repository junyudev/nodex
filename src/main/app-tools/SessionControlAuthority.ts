import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SessionExecutionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import type { make as makeNative } from "./NativeSessionPermissionFacts";
import { make as makeRuntime } from "./RuntimeSessionMessageIntake";
import { sessionMessageCeilingError } from "./session-message-policy";
export class SessionControlError extends Schema.TaggedError<SessionControlError>()(
  "SessionControlError",
  { reason: Schema.String, message: Schema.String },
) {}
export const denied = (reason: string, message = reason) =>
  new SessionControlError({ reason, message });
/** Explicit Session control has the same Profile authority and execution ceiling as messaging. */
export const makeWithNative = (native: Effect.Success<typeof makeNative> | null) =>
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const runtime = yield* makeRuntime;
    const authorize = Effect.fn("SessionControlAuthority.authorize")(function* (sessionId: string) {
      const provenance = yield* CoreApplicationAgent;
      if (!provenance) return yield* denied("authority_unavailable");
      const result = yield* core.workspace.read(
        { kind: "agent_session", session_id: sessionId, provenance },
        { deadlineMs: 10000 },
        provenance.authority.actor_project_id,
      );
      if (result.value.kind !== "agent_session" || result.value.session.archived)
        return yield* denied("session_unavailable");
      return result.value;
    });
    const inspect = Effect.fn("SessionControlAuthority.inspect")(function* (
      target: SessionExecutionTarget,
    ) {
      const session = yield* authorize(target.sessionId);
      if (session.session.execution_ref) return yield* runtime.inspect(target);
      if (!native) return yield* denied("unsupported", "No native execution owner is available");
      return yield* native.inspect(target);
    });
    return {
      authorize,
      inspect,
      check: Effect.fn("SessionControlAuthority.check")(function* (
        caller: SessionExecutionTarget,
        target: SessionExecutionTarget,
      ) {
        const source = yield* inspect(caller);
        const session = yield* authorize(target.sessionId);
        if (!session.session.execution_ref && !session.thread) {
          if (target.execution)
            return yield* denied("unsupported", "A draft has no child execution");
          return { session, facts: null };
        }
        if (!session.session.execution_ref && target.execution)
          return yield* denied("unsupported", "Native child execution is unavailable");
        const facts = yield* inspect(target);
        if (!session.session.execution_ref && source.runtimeMode !== "full-access")
          return yield* denied("runtime_mode_escalation_denied");
        const error = sessionMessageCeilingError(source, facts);
        if (error) return yield* denied(error);
        return { session, facts };
      }),
    };
  });
