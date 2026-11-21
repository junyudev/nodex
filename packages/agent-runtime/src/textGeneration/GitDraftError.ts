import * as Schema from "effect/Schema";

export class GitDraftError extends Schema.TaggedError<GitDraftError>()("GitDraftError", {
  code: Schema.Literal("no_writing_agent"),
  message: Schema.String,
}) {}
