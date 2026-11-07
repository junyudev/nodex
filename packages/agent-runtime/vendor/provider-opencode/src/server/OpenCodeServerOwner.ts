import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerOwnerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("@nodex/provider-opencode/server/OpenCodeServerOwner") {}

/** Owns the lazy local OpenCode server shared by one provider instance. */
export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  let closed = false;
  const state: OpenCodeServerOwnerState = {
    server: null,
    serverScope: null,
    borrowers: 0,
    idleCloseFiber: null,
  };

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (
    expected?: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    if (expected !== undefined && state.server !== expected) {
      return;
    }
    const scope = state.serverScope;
    state.server = null;
    state.serverScope = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        yield* cancelIdleClose();
        yield* closeServer(server);
      }),
    );
  });

  const acquireServer = mutex.withPermit(
    Effect.gen(function* () {
      if (closed) {
        return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: "The provider server owner is closed.",
        });
      }
      yield* cancelIdleClose();
      if (state.server !== null) {
        if (yield* state.server.isRunning) {
          state.borrowers += 1;
          return state.server;
        }
        yield* closeServer(state.server);
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const serverScope = yield* Scope.fork(ownerScope);
          const started = yield* Effect.exit(
            restore(
              runtime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  directory: input.directory,
                  ...(input.serverPassword !== undefined
                    ? { serverPassword: input.serverPassword }
                    : {}),
                  ...(input.environment ? { environment: input.environment } : {}),
                  ...(input.verify ? { verify: input.verify } : {}),
                })
                .pipe(Effect.provideService(Scope.Scope, serverScope)),
            ),
          );
          if (Exit.isFailure(started)) {
            yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }

          const server = started.value;
          state.server = server;
          state.serverScope = serverScope;
          state.borrowers = 1;
          yield* watchServerExit(server).pipe(Effect.forkIn(ownerScope));
          return server;
        }),
      );
    }),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (closed || state.server !== server) {
          return;
        }
        state.borrowers = Math.max(0, state.borrowers - 1);
        if (state.borrowers > 0) {
          return;
        }
        yield* cancelIdleClose();
        state.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (state.server !== server || state.borrowers > 0) {
                  return;
                }
                state.idleCloseFiber = null;
                yield* closeServer(server);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }).pipe(
      // Startup fibers and their child Scopes end before waiting for the startup mutex.
      Effect.andThen(Scope.close(ownerScope, Exit.void)),
      Effect.andThen(
        mutex.withPermit(
          Effect.gen(function* () {
            state.borrowers = 0;
            state.idleCloseFiber = null;
            yield* closeServer();
          }),
        ),
      ),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: (use) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const startup = yield* acquireServer.pipe(
            Effect.forkIn(ownerScope, { uninterruptible: false }),
          );
          const server = yield* restore(Fiber.join(startup)).pipe(
            Effect.onInterrupt(() =>
              Fiber.interrupt(startup).pipe(
                Effect.andThen(Fiber.await(startup)),
                Effect.flatMap((exit) =>
                  Exit.isSuccess(exit) ? releaseServer(exit.value) : Effect.void,
                ),
              ),
            ),
          );
          return yield* restore(use(server)).pipe(Effect.ensuring(releaseServer(server)));
        }),
      ),
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
