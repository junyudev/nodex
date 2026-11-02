import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ConnectOrStartCoreInput, CoreLaunchResult } from "../core-client/core-launcher";
import { connectOrStartCore } from "../core-client/core-launcher";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { CoreRuntimeError, coreRuntimeError } from "./CoreRuntimeError";

export interface CoreTransportSession {
  readonly client: CoreGenerationClient;
  readonly launch: Omit<CoreLaunchResult, "client">;
}

export class CoreTransport extends Context.Service<
  CoreTransport,
  {
    readonly launch: Effect.Effect<CoreTransportSession, CoreRuntimeError>;
  }
>()("nodex/main/core-runtime/CoreTransport") {}

export type CoreTransportLaunch = (signal: AbortSignal) => Promise<CoreTransportSession>;

/** The only Core lifecycle seam that translates Effect interruption into AbortSignal. */
export const fromLaunch = (launch: CoreTransportLaunch): Layer.Layer<CoreTransport> =>
  Layer.succeed(
    CoreTransport,
    CoreTransport.of({
      launch: Effect.tryPromise({
        try: launch,
        catch: (cause) =>
          coreRuntimeError({ operation: "launch", reason: "launch", retryable: true, cause }),
      }).pipe(
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: () => session.client.health(),
            catch: (cause) =>
              coreRuntimeError({ operation: "health", reason: "health", retryable: true, cause }),
          }).pipe(
            Effect.flatMap((health) =>
              health.status === "ready"
                ? Effect.succeed(session)
                : Effect.fail(
                    coreRuntimeError({
                      operation: "health",
                      reason: "health",
                      retryable: true,
                      cause: new Error(`Unexpected Core health status ${health.status}`),
                    }),
                  ),
            ),
          ),
        ),
      ),
    }),
  );

export const live = (input: ConnectOrStartCoreInput): Layer.Layer<CoreTransport> =>
  fromLaunch((signal) =>
    connectOrStartCore({ ...input, signal }).then((launch) => {
      const { client, ...metadata } = launch;
      return { client, launch: metadata };
    }),
  );
