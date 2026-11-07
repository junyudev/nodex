import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const read = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly coordinate: string | null }>`
    SELECT store_coordinate AS coordinate FROM execution_store_state WHERE singleton = 1`;
  return { coordinate: row!.coordinate };
}).pipe(NodeSqliteClient.readOnly);

export const record = Effect.fn("StoreCoordinate.record")(function* (coordinate: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE execution_store_state SET store_coordinate = ${coordinate} WHERE singleton = 1`;
  return { recorded: true as const };
});
