import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

for (const mode of ["first", "success"] as const) {
  it.effect(`${mode} race settles a synchronously losing child before returning`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const winner = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const events: string[] = [];
        const losing = Deferred.succeed(winner, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => events.push("late action"))),
          Effect.ensuring(Effect.sync(() => events.push("released"))),
        );
        const race = mode === "first" ? Effect.raceFirst : Effect.race;
        yield* race(Deferred.await(winner), losing);
        assert.deepEqual(events, ["released"]);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        assert.deepEqual(events, ["released"]);
      }),
    ),
  );
}

it.effect("a synchronously failed race waits for the losing child's cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const winner = yield* Deferred.make<never, "retired">();
      const release = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupFinished = yield* Deferred.make<void>();
      const events: string[] = [];
      const losing = Deferred.fail(winner, "retired").pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.sync(() => events.push("late action"))),
        Effect.ensuring(
          Deferred.succeed(cleanupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(cleanupFinished)),
            Effect.andThen(Effect.sync(() => events.push("released"))),
          ),
        ),
      );
      const running = yield* Effect.raceFirst(Deferred.await(winner), losing).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(cleanupStarted);
      assert.isUndefined(running.pollUnsafe());
      yield* Deferred.succeed(cleanupFinished, undefined);
      const result = yield* Fiber.join(running);
      assert.isTrue(result._tag === "Failure" && result.failure === "retired");
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(events, ["released"]);
    }),
  ),
);
