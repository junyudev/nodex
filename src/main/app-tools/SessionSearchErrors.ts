import * as Schema from "effect/Schema";

export class NativeSessionSearchStale extends Schema.TaggedError<NativeSessionSearchStale>()(
  "NativeSessionSearchStale",
  { cause: Schema.Defect() },
) {}
