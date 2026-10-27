import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as Effect from "effect/Effect";

/** Private, disposable projection storage; SQLite removes the temporary file on close. */
export const makeTemporarySqlite = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.try(() => new DatabaseSync("")),
    (db) => Effect.sync(() => db.close()),
  );
  const execute = (sql: string, values: readonly SQLInputValue[] = []) =>
    Effect.try(() => {
      database.prepare(sql).run(...values);
    });
  const rows = <T>(sql: string, values: readonly SQLInputValue[] = []) =>
    Effect.try(() => database.prepare(sql).all(...values) as T[]);
  yield* execute("PRAGMA cache_size = -1024");
  yield* execute("PRAGMA temp_store = FILE");
  const transaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* execute("BEGIN");
        const result = yield* restore(body).pipe(Effect.exit);
        yield* execute(result._tag === "Success" ? "COMMIT" : "ROLLBACK");
        return yield* result;
      }),
    );
  return { execute, rows, transaction };
});
