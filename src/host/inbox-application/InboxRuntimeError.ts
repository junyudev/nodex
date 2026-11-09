import * as Schema from "effect/Schema";

/** A suggestion or model selection failed with a user-presentable reason. */
export class InboxRuntimeError extends Schema.TaggedError<InboxRuntimeError>()(
  "InboxRuntimeError",
  { message: Schema.String },
) {}
