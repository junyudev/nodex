import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ClaudeSessionManager } from "./ClaudeSessionManager";

/** Other backend tests fail if they accidentally open a native Claude runtime. */
export const inactiveClaudeSessions = Layer.succeed(
  ClaudeSessionManager,
  ClaudeSessionManager.of({
    discover: () => Effect.die(new Error("Unexpected Claude discovery")),
    models: () => Effect.die(new Error("Unexpected Claude model discovery")),
    open: () => Effect.die(new Error("Unexpected native Claude launch")),
    get: () => Effect.succeed(null),
    close: () => Effect.void,
    observe: () => Effect.void,
    unobserve: () => Effect.void,
    changes: Stream.empty,
  }),
);
