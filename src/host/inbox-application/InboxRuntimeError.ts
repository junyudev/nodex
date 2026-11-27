import * as Schema from "effect/Schema";

/** A suggestion or model selection failed with a user-presentable reason. */
export class InboxRuntimeError extends Schema.TaggedError<InboxRuntimeError>()(
  "InboxRuntimeError",
  {
    message: Schema.String,
    /** The next dispatch pass can retry an unsettled catalog or a transport failure. */
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}
