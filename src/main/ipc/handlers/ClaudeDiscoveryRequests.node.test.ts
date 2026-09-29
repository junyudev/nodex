import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeClaudeDiscoveryRequests } from "./ClaudeDiscoveryRequests";

it.effect(
  "cancellation belongs to the requesting viewer and closes acquisition before acknowledging",
  () =>
    Effect.gen(function* () {
      const requests = yield* makeClaudeDiscoveryRequests;
      const admitted = yield* Deferred.make<void>();
      let released = false;
      const query = yield* Effect.forkChild(
        requests.run(
          1,
          "request",
          Effect.acquireRelease(Deferred.succeed(admitted, undefined), () =>
            Effect.sync(() => {
              released = true;
            }),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(admitted);
      yield* requests.cancel(2, "request");
      expect(released).toBe(false);
      yield* requests.cancel(1, "request");
      expect(released).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
      expect(yield* requests.run(1, "request", Effect.succeed("fresh"))).toBe("fresh");
      expect(
        Exit.isFailure(
          yield* Effect.exit(requests.run(2, "request", Effect.succeed("wrong viewer"))),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect("early cancellation and scope shutdown do not leak pending requests", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const requests = yield* makeClaudeDiscoveryRequests.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    let evaluated = false;
    yield* requests.cancel(1, "early");
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          requests.run(
            1,
            "early",
            Effect.sync(() => {
              evaluated = true;
            }),
          ),
        ),
      ),
    ).toBe(true);
    expect(evaluated).toBe(false);
    const admitted = yield* Deferred.make<void>();
    let released = false;
    const query = yield* Effect.forkChild(
      requests.run(
        1,
        "active",
        Effect.acquireRelease(Deferred.succeed(admitted, undefined), () =>
          Effect.sync(() => {
            released = true;
          }),
        ).pipe(Effect.andThen(Effect.never)),
      ),
    );
    yield* Deferred.await(admitted);
    yield* Scope.close(scope, Exit.void);
    expect(released).toBe(true);
    expect(Exit.isFailure(yield* Fiber.await(query))).toBe(true);
    expect((yield* Effect.result(requests.run(1, "after-close", Effect.void)))._tag).toBe(
      "Failure",
    );
  }).pipe(Effect.scoped),
);
