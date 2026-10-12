import * as Schema from "effect/Schema";

export class CodexMediaError extends Schema.TaggedError<CodexMediaError>()("CodexMediaError", {
  operation: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
