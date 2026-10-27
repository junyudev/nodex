import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { resolveSessionScope } from "../../shared/nodex-app-tools/session-scope";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { SessionWaiter, type SessionWaitResult } from "./SessionWaiter";
import { SessionObservation } from "./SessionObservation";
import { toolFailure, toolSuccess, toolResultBytes } from "./app-tool-result";
import { SESSION_READ_MAX_BYTES } from "./SessionHistoryRead";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";

/** Keep every target observable even when its progress cannot fit the shared response. */
export const boundSessionWaitResult = (result: SessionWaitResult): SessionWaitResult => {
  const targets = [...result.targets];
  const errors = [...result.errors];
  const fits = () => toolResultBytes({ ...result, targets, errors }) <= 32 * 1024;
  for (let index = targets.length - 1; index >= 0 && !fits(); index--) {
    const target = targets[index]!;
    if (!target.progress) continue;
    targets[index] = {
      ...target,
      progress: {
        availability: "unavailable",
        reason: "response_budget",
        coverage: "unavailable",
        nextCursor: null,
        latestMessage: null,
        latestTool: null,
      },
    };
  }
  while (targets.length > 0 && !fits()) {
    const target = targets.pop()!;
    errors.push({
      kind: "error",
      sessionId: target.sessionId,
      ...(target.execution ? { execution: target.execution } : {}),
      reason: "source_limit",
    });
  }
  return { ...result, targets, errors };
};

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
          ? toolSuccess({ ...boundSessionWaitResult(result) }, 32 * 1024)
          : toolFailure("call_withdrawn");
      }
      if (input.name === "search_sessions") {
        const parsed = sessionObservationSchemas.search_sessions.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        return yield* observations
          .search({
            ...parsed.data,
            ...resolveSessionScope(parsed.data, authority.actorProjectId ?? null),
          })
          .pipe(
            Effect.provideService(
              CoreApplicationAgent,
              toCoreAgentTurnProvenance(core.identity.profileId, authority),
            ),
            Effect.map((result) => {
              if (!input.caller.isActive()) return toolFailure("call_withdrawn");
              const { entryCursors, ...value } = result;
              let count = value.matches.length;
              while (count > 0) {
                const bounded = {
                  ...value,
                  matches: value.matches.slice(0, count),
                  nextCursor:
                    count === value.matches.length ? value.nextCursor : entryCursors[count - 1]!,
                };
                if (toolResultBytes(bounded) <= 32 * 1024) return toolSuccess(bounded, 32 * 1024);
                count--;
              }
              return value.matches.length === 0
                ? toolSuccess(value, 32 * 1024)
                : toolFailure(
                    "session_source_limit",
                    "Search identity exceeds the response budget.",
                  );
            }),
            Effect.catch((error) => Effect.succeed(toolFailure(`session_${error.reason}`))),
          );
      }
      if (input.name === "list_sessions" || input.name === "list_archived_sessions") {
        const parsed = sessionObservationSchemas[input.name].safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        return yield* observations
          .list({
            ...parsed.data,
            ...resolveSessionScope(parsed.data, authority.actorProjectId ?? null),
            archived: input.name === "list_archived_sessions",
          })
          .pipe(
            Effect.provideService(
              CoreApplicationAgent,
              toCoreAgentTurnProvenance(core.identity.profileId, authority),
            ),
            Effect.map((result) => {
              if (!input.caller.isActive()) return toolFailure("call_withdrawn");
              const { entryCursors, ...value } = result;
              let count = value.sessions.length;
              while (count > 0) {
                const bounded = {
                  ...value,
                  sessions: value.sessions.slice(0, count),
                  nextCursor:
                    count === value.sessions.length ? value.nextCursor : entryCursors[count - 1]!,
                };
                if (toolResultBytes(bounded) <= 32 * 1024) return toolSuccess(bounded, 32 * 1024);
                count -= 1;
              }
              return value.sessions.length === 0
                ? toolSuccess(value, 32 * 1024)
                : toolFailure(
                    "session_source_limit",
                    "Session identity exceeds the response budget.",
                  );
            }),
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
              ? toolSuccess({ ...result }, SESSION_READ_MAX_BYTES)
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
