import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { SessionWaiter } from "./SessionWaiter";
import { SessionObservation } from "./SessionObservation";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const core = yield* CoreAuthority;
    const observations = yield* SessionObservation;
    const waiter = yield* SessionWaiter;
    return Effect.fn("SessionAppTools.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      if (input.name === "wait_sessions") {
        const parsed = sessionObservationSchemas.wait_sessions.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const result = yield* waiter.wait(
          parsed.data,
          toCoreAgentTurnProvenance(core.identity.profileId, authority),
        );
        return input.caller.isActive()
          ? toolSuccess({ ...result }, 32 * 1024)
          : toolFailure("call_withdrawn");
      }
      if (input.name === "list_sessions" || input.name === "list_archived_sessions") {
        const parsed = sessionObservationSchemas[input.name].safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        return yield* observations
          .list({ ...parsed.data, archived: input.name === "list_archived_sessions" })
          .pipe(
            Effect.provideService(
              CoreApplicationAgent,
              toCoreAgentTurnProvenance(core.identity.profileId, authority),
            ),
            Effect.map((result) =>
              input.caller.isActive()
                ? toolSuccess(result, 32 * 1024)
                : toolFailure("call_withdrawn"),
            ),
            Effect.catch((error) => Effect.succeed(toolFailure(`session_${error.reason}`))),
          );
      }
      if (input.name !== "read_session") return toolFailure("unknown_tool");
      const parsed = sessionObservationSchemas.read_session.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const sessionId =
        parsed.data.sessionId ??
        (yield* resolveAppToolCallingSession(input.caller, workspace))?.sessionId;
      if (!sessionId) return toolFailure("session_unavailable");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      return yield* observations
        .read(
          { ...parsed.data, sessionId },
          toCoreAgentTurnProvenance(core.identity.profileId, authority),
        )
        .pipe(
          Effect.map((result) =>
            input.caller.isActive()
              ? toolSuccess({ ...result }, 24 * 1024)
              : toolFailure("call_withdrawn"),
          ),
          Effect.catch((error) => Effect.succeed(toolFailure(`session_${error.reason}`))),
        );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
