import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const database = SqlitePersistence.layerMemory;

it.effect("returns free pages and starts pruning once the store has been running a minute", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      assert.equal(mode[0]?.auto_vacuum, 2);
      yield* sql`CREATE TABLE filler(value TEXT)`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
        INSERT INTO filler SELECT printf('%.4096c', 'x') FROM n`;
      yield* sql`DROP TABLE filler`;
      const freeBefore = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      assert.isAbove(freeBefore[0]?.freelist_count ?? 0, 100);

      yield* Layer.build(
        DatabaseStorage.layer.pipe(
          Layer.provide(ProjectionMaintenance.layer.pipe(Layer.provide(database))),
        ),
      );
      const mark = sql<{ readonly last_sequence: number }>`
        SELECT last_sequence FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'event-log-prune-mark'`;
      assert.lengthOf(yield* mark, 0);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow;
      const freeAfter = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      assert.equal(freeAfter[0]?.freelist_count, 0);
      assert.lengthOf(yield* mark, 1);
    }),
  ).pipe(Effect.provide(database)),
);
