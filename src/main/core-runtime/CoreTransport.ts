import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ConnectOrStartCoreInput, CoreLaunchResult } from "../core-client/core-launcher";
import { connectOrStartCore } from "../core-client/core-launcher";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { CoreRuntimeError, coreRuntimeError } from "./CoreRuntimeError";

export interface CoreTransportSession {
  readonly client: CoreGenerationClient;
  readonly launch: Omit<CoreLaunchResult, "client">;
  /** Gracefully stops the exact authority generation and waits for its OS process to exit. */
  readonly release: Effect.Effect<void, CoreRuntimeError>;
}

export class CoreTransport extends Context.Service<
  CoreTransport,
  {
    readonly launch: Effect.Effect<CoreTransportSession, CoreRuntimeError>;
  }
>()("nodex/main/core-runtime/CoreTransport") {}

export type CoreTransportLaunch = (signal: AbortSignal) => Promise<CoreTransportSession>;

const CORE_SHUTDOWN_DEADLINE = Duration.seconds(5);
const CORE_SHUTDOWN_POLL_INTERVAL = Duration.millis(25);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((cause as NodeJS.ErrnoException).code === "EPERM") return true;
    throw cause;
  }
};

const releaseGeneration = (client: CoreGenerationClient): Effect.Effect<void, CoreRuntimeError> => {
  const generation = client.handshake.generation;
  const alive = Effect.try({
    try: () => isProcessAlive(generation.pid),
    catch: (cause) =>
      coreRuntimeError({
        operation: "shutdown.observe",
        reason: "operation",
        retryable: false,
        generation: generation.start_nonce,
        cause,
      }),
  });
  return Effect.gen(function* () {
    if (!(yield* alive)) return;
    const response = yield* Effect.tryPromise({
      try: () => client.shutdown(),
      catch: (cause) =>
        coreRuntimeError({
          operation: "shutdown",
          reason: "operation",
          retryable: false,
          generation: generation.start_nonce,
          cause,
        }),
    });
    if (response.status !== "draining") {
      return yield* coreRuntimeError({
        operation: "shutdown",
        reason: "protocol",
        retryable: false,
        generation: generation.start_nonce,
        cause: new Error(`Unexpected Core shutdown status ${response.status}`),
      });
    }
    while (yield* alive) yield* Effect.sleep(CORE_SHUTDOWN_POLL_INTERVAL);
  }).pipe(
    Effect.timeout(CORE_SHUTDOWN_DEADLINE),
    Effect.mapError((cause) =>
      Schema.is(CoreRuntimeError)(cause)
        ? cause
        : coreRuntimeError({
            operation: "shutdown",
            reason: "operation",
            retryable: false,
            generation: generation.start_nonce,
            cause,
          }),
    ),
  );
};

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
      return { client, launch: metadata, release: releaseGeneration(client) };
    }),
  );
