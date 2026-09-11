import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { AppProtocolRuntime } from "./AppProtocolRuntime";

/** Registers host asset reads after the Codex runtime is ready, without reversing its dependency on platform protocols. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const protocol = yield* AppProtocolRuntime;
    const gateway = yield* CodexGateway;
    const callbacks = yield* ScopedCallbackRuntime;
    yield* protocol.registerHostFileReader((input) =>
      callbacks.runPromise(
        gateway.requestOnHost(input.hostId, "fs/readFile", { path: input.path }).pipe(
          Effect.map((result) => Buffer.from(result.dataBase64, "base64")),
          Effect.catch(() => Effect.succeed(null)),
        ),
        { signal: input.signal },
      ),
    );
  }),
);
