import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";

/** Test adapter for modules whose focused behavior is unrelated to protocol start ordering. */
export const transparentThreadCreationRuntime = ThreadCreationRuntime.of({
  materialize: (_hostId, _generation, operation) => operation,
  defer: () => false,
  releases: Stream.empty,
  termination: Effect.never,
  clear: () => undefined,
});
