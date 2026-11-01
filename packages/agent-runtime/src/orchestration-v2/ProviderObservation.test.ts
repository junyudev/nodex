import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { SqlError, UnknownError, SqlSyntaxError, LockTimeoutError } from "effect/sql/SqlError";
import { isTransientObservationFailure, retryObservation } from "./ProviderObservation.ts";

it("retries only transport, lock, interruption and I/O SQL errors", () => {
  for (const reason of [
    new LockTimeoutError({ cause: "busy" }),
    new UnknownError({
      cause: new Error("Database reader query was interrupted"),
      message: "Database reader query was interrupted",
    }),
    new UnknownError({ cause: { code: "SQLITE_IOERR_READ" } }),
  ])
    assert.isTrue(isTransientObservationFailure({ cause: Cause.die(new SqlError({ reason })) }));
  for (const error of [
    new SqlError({ reason: new SqlSyntaxError({ cause: "no such table" }) }),
    new SqlError({ reason: new UnknownError({ cause: "malformed database" }) }),
    new Error("database is locked"),
    { _tag: "SchemaError", message: "bad field" },
  ])
    assert.isFalse(isTransientObservationFailure(error));
});

it.effect("retries SQL defects as well as typed persistence failures", () =>
  Effect.gen(function* () {
    let count = 0;
    const fiber = yield* retryObservation(
      Effect.suspend(() =>
        ++count < 3
          ? Effect.die(new SqlError({ reason: new LockTimeoutError({ cause: "SQLITE_BUSY" }) }))
          : Effect.succeed("persisted"),
      ),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Fiber.join(fiber), "persisted");
    assert.equal(count, 3);
  }),
);
