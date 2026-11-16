import * as Data from "effect/Data";

/** Safe to include in the chat startup diagnostic. The message omits paths and underlying causes. */
export class PluginSessionPreparationError extends Data.TaggedError(
  "PluginSessionPreparationError",
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
