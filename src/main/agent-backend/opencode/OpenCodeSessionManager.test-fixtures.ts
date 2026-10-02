import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { OpenCodeSessionManager } from "./OpenCodeSessionManager";

/** Other backend tests fail if they accidentally acquire an OpenCode runtime. */
export const inactiveOpenCodeSessions = Layer.succeed(
  OpenCodeSessionManager,
  OpenCodeSessionManager.of({
    nativeHome: () => Effect.die("Unexpected OpenCode native owner"),
    discover: () => Effect.die("Unexpected OpenCode inventory"),
    open: () => Effect.die("Unexpected OpenCode runtime"),
    get: () => Effect.succeed(null),
    close: () => Effect.void,
    observe: () => Effect.void,
    unobserve: () => Effect.void,
    changes: Stream.empty,
  }),
);
