import * as Effect from "effect/Effect";
import { SessionQuestionError, type SessionQuestionBackend } from "./SessionQuestions";

const unsupported = () =>
  Effect.fail(
    new SessionQuestionError({
      code: "unsupported",
      message: "Native Session questions are unavailable",
    }),
  );

/** Native question delivery is supplied by the Native execution owner. */
export const make = Effect.succeed<SessionQuestionBackend>({
  list: unsupported,
  read: unsupported,
  respond: unsupported,
});
