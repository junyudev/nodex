/* oxlint-disable effecttsgo/strict-effect-provide -- This test owns one isolated callback runtime and resource Scope. */
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { connectAppToolsPipe } from "@nodex/app-tools-mcp/pipe";
import { layer as callbacks } from "../../app/ScopedCallbackRuntime";
import { acquireAppToolPipe, AppToolPipeError } from "./NodexAppToolPipe";

it.effect("closing the owning Scope cancels host work and removes its private endpoint", () =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const descriptor = yield* acquireAppToolPipe({
      listTools: Effect.succeed([]),
      callTool: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(admitted, undefined);
          return yield* Effect.never;
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))),
    }).pipe(Scope.provide(scope));
    const directory = yield* Effect.tryPromise(() => stat(dirname(descriptor.path)));
    expect(directory.mode & 0o777).toBe(0o700);
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise(() => connectAppToolsPipe(descriptor)),
      (client) => Effect.sync(() => client.close()),
    );
    const pending = yield* Effect.tryPromise({
      try: (signal) =>
        client.callTool({ name: "wait_sessions", arguments: {}, metadata: {}, signal }),
      catch: (cause) => new AppToolPipeError({ cause }),
    }).pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(admitted);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(cancelled);
    expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
    const removed = yield* Effect.tryPromise(() => stat(dirname(descriptor.path))).pipe(
      Effect.exit,
    );
    expect(Exit.isFailure(removed)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(callbacks)),
);
