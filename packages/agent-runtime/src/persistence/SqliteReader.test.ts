import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as SqliteClient from "../../vendor/shared/src/nodeSqliteClient.ts";
const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});
const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("in-memory databases keep one connection even when reader isolation is enabled", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = startedWorkers.length;
    yield* sql`CREATE TABLE entries(name TEXT)`;
    yield* sql`INSERT INTO entries VALUES ('local')`;
    assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    assert.equal(startedWorkers.length, before);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", readerWorker: true }))),
);
it.effect(
  "interrupting a queued reader releases its lease without breaking the open snapshot",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(entered);
        const waiting = yield* sql
          .withTransaction(countEntries(sql))
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      }),
    ),
);
it.effect("preserves positional rows, safe integers and prepare retries on the reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const first = yield* sql`SELECT count(*) AS n FROM later_schema`.pipe(
        SqliteClient.readOnly,
        Effect.flip,
      );
      assert.equal(first.reason.operation, "prepare");
      yield* sql`CREATE TABLE later_schema(name TEXT)`;
      const query = sql`SELECT 1 AS id, ${"x".repeat(70000)} AS text`;
      const values = yield* query.values.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        SqliteClient.readOnly,
      );
      assert.deepEqual(values, [[1n, "x".repeat(70000)]]);
      assert.deepEqual(yield* query.valuesUnprepared.pipe(SqliteClient.readOnly), [
        [1, "x".repeat(70000)],
      ]);
      assert.deepEqual(
        yield* sql`SELECT count(*) AS n FROM later_schema`.pipe(SqliteClient.readOnly),
        [{ n: 0 }],
      );
    }),
  ),
);

it.effect("retires an interrupted in-flight SQL generation before the next reader lease", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const priorCount = startedWorkers.length;
      let announce: () => void = () => {};
      const dispatched = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const exited = new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
      });
      const originalPost = worker.postMessage.bind(worker);
      const posted = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
        originalPost(message, ...rest);
        if (typeof message.sql === "string" && message.sql.includes("WITH RECURSIVE")) announce();
      });
      const terminated = vi.spyOn(worker, "terminate");
      try {
        const operation = yield* sql
          .withTransaction(sql`
        WITH RECURSIVE sequence(value) AS (VALUES(1) UNION ALL
          SELECT value+1 FROM sequence WHERE value<100000000)
        SELECT SUM(value) AS total FROM sequence
      `)
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Effect.promise(() => dispatched);
        yield* Fiber.interrupt(operation);
        assert.equal(terminated.mock.calls.length, 1);
        // A replacement reads successfully while retirement of the cancelled native SQL is pending.
        assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
        assert.equal(startedWorkers.length, priorCount + 1);
        yield* Effect.promise(() => exited);
      } finally {
        posted.mockRestore();
        terminated.mockRestore();
      }
    }),
  ),
);
