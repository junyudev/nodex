import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeTemporarySqlite } from "./TemporarySqlite";

it.effect("rolls back incomplete index admission after failure or cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* makeTemporarySqlite;
      yield* db.execute("CREATE TABLE facts(id TEXT PRIMARY KEY)");
      yield* db.transaction(db.execute("INSERT INTO facts VALUES(?)", ["confirmed"]));
      const failed = yield* db
        .transaction(
          db
            .execute("INSERT INTO facts VALUES(?)", ["failed"])
            .pipe(Effect.andThen(Effect.fail("rejected"))),
        )
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      const admitted = yield* Deferred.make<void>();
      const writer = yield* db
        .transaction(
          db
            .execute("INSERT INTO facts VALUES(?)", ["cancelled"])
            .pipe(
              Effect.andThen(Deferred.succeed(admitted, undefined)),
              Effect.andThen(Effect.never),
            ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(admitted);
      yield* Fiber.interrupt(writer);
      assert.deepEqual(yield* db.rows<{ id: string }>("SELECT id FROM facts ORDER BY id"), [
        { id: "confirmed" },
      ]);
      yield* db.transaction(db.execute("INSERT INTO facts VALUES(?)", ["resumed"]));
      assert.equal((yield* db.rows("SELECT id FROM facts")).length, 2);
    }),
  ),
);

it.effect("releases each private index with its lexical scope", () =>
  Effect.gen(function* () {
    const closed = yield* Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeTemporarySqlite;
        yield* db.execute("CREATE TABLE facts(id TEXT)");
        return db;
      }),
    );
    assert.equal((yield* closed.rows("SELECT * FROM facts").pipe(Effect.result))._tag, "Failure");
    const isolated = yield* Effect.scoped(
      makeTemporarySqlite.pipe(
        Effect.flatMap((db) => db.rows("SELECT name FROM sqlite_master WHERE name='facts'")),
      ),
    );
    assert.isEmpty(isolated);
  }),
);
