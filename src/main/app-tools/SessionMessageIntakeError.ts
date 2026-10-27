import * as Schema from "effect/Schema";

export class SessionMessageIntakeError extends Schema.TaggedError<SessionMessageIntakeError>()(
  "SessionMessageIntakeError",
  { message: Schema.String },
) {}
