import * as Effect from "effect/Effect";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make as makeRuntime } from "./RuntimeSessionQuestions";
import { make as makeNative } from "./UnsupportedSessionQuestions";
import { make as makeMessageIntake } from "./SessionMessageIntake";
import { sessionMessageCeilingError, type SessionMessageFacts } from "./session-message-policy";
import {
  SessionQuestionError,
  type SessionQuestionBackend,
  type SessionQuestionTarget,
} from "./SessionQuestions";

/** Admission is shared by all actions, including observation and exact retries. */
export const authorizeSessionQuestions = Effect.fn("SessionQuestions.authorize")(function* (
  caller: SessionQuestionTarget,
  target: SessionQuestionTarget,
  readOwner: (sessionId: string) => Effect.Effect<"runtime" | "native", SessionQuestionError>,
  inspect: (
    target: SessionQuestionTarget,
  ) => Effect.Effect<SessionMessageFacts, SessionQuestionError>,
) {
  yield* readOwner(caller.sessionId);
  const owner = yield* readOwner(target.sessionId);
  const callerFacts = yield* inspect(caller);
  const targetFacts = yield* inspect(target);
  const denied = sessionMessageCeilingError(callerFacts, targetFacts);
  if (denied) return yield* new SessionQuestionError({ code: "forbidden", message: denied });
  // Native Session messaging admits only full-access callers before owner operations.
  if (owner === "native" && callerFacts.runtimeMode !== "full-access")
    return yield* new SessionQuestionError({
      code: "forbidden",
      message: "runtime_mode_escalation_denied",
    });
  return { owner, callerFacts };
});

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* makeRuntime;
  const native: SessionQuestionBackend = yield* makeNative;
  const messages = yield* makeMessageIntake;
  const readOwner = Effect.fn("SessionQuestions.readOwner")(function* (sessionId: string) {
    const provenance = yield* CoreApplicationAgent;
    if (!provenance)
      return yield* new SessionQuestionError({
        code: "forbidden",
        message: "Question execution authority is unavailable",
      });
    const response = yield* core.workspace
      .read(
        { kind: "agent_session", session_id: sessionId, provenance },
        { deadlineMs: 10_000 },
        provenance.authority.actor_project_id,
      )
      .pipe(
        Effect.mapError(
          () =>
            new SessionQuestionError({
              code: "not_found",
              message: "Question Session is unavailable",
            }),
        ),
      );
    if (response.value.kind !== "agent_session" || response.value.session.archived)
      return yield* new SessionQuestionError({
        code: "not_found",
        message: "Question Session is unavailable",
      });
    return response.value.session.execution_ref ? ("runtime" as const) : ("native" as const);
  });
  return Effect.fn("SessionQuestions.admit")(function* (
    caller: SessionQuestionTarget,
    target: SessionQuestionTarget,
  ) {
    const { owner, callerFacts } = yield* authorizeSessionQuestions(
      caller,
      target,
      readOwner,
      (target) =>
        messages.inspect(target).pipe(
          Effect.mapError(
            (cause) =>
              new SessionQuestionError({
                code: "unavailable",
                message:
                  cause instanceof Error ? cause.message : "Question execution is unavailable",
              }),
          ),
        ),
    );
    return owner === "runtime" ? runtime(callerFacts.interactionMode) : native;
  });
});
