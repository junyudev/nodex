import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

it.effect("queued readers bind to a replacement after an executing read is interrupted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-reader-recovery-" });
    const filename = path.join(directory, "state.sqlite");

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      const countEntries = sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`.pipe(
        Effect.map((rows) => rows[0]?.count),
      );
      assert.equal(yield* countEntries.pipe(SqliteClient.readOnly), 1);
      const worker = startedWorkers.at(-1)!;
      const priorCount = startedWorkers.length;
      let announce: () => void = () => {};
      const dispatched = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const originalPost = worker.postMessage.bind(worker);
      const posted = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
        originalPost(message, ...rest);
        if (typeof message.sql === "string" && message.sql.includes("WITH RECURSIVE")) announce();
      });
      const terminated = vi.spyOn(worker, "terminate");

      try {
        const leader = yield* sql
          .withTransaction(sql`
          WITH RECURSIVE sequence(value) AS (VALUES(1) UNION ALL
            SELECT value+1 FROM sequence WHERE value<100000000)
          SELECT SUM(value) AS total FROM sequence
        `)
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* Effect.promise(() => dispatched);
        const reservedRead = Effect.scoped(
          Effect.flatMap(sql.reserve, (connection) =>
            connection
              .executeValues("SELECT COUNT(*) AS count FROM entries", [])
              .pipe(Effect.map((rows) => rows[0]?.[0])),
          ),
        );
        // Ordinary statements borrow; transactions and reserve hold scoped leases.
        const reads = [countEntries, sql.withTransaction(countEntries), reservedRead];
        const queued = yield* Effect.forEach(
          Array.from({ length: 9 }, (_, index) => index),
          (index) =>
            reads[index % reads.length]!.pipe(
              SqliteClient.readOnly,
              Effect.exit,
              Effect.forkChild({ startImmediately: true }),
            ),
        );
        // Let every acquisition reach the occupied reader lease before retiring its worker.
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        yield* Fiber.interrupt(leader);
        const outcomes = yield* Effect.forEach(queued, Fiber.join);

        assert.equal(terminated.mock.calls.length, 1);
        yield* sql`INSERT INTO entries VALUES ('writer-alive')`;
        assert.equal(yield* countEntries, 2);
        assert.equal(yield* countEntries.pipe(SqliteClient.readOnly), 2);
        for (const outcome of outcomes) assert.deepEqual(outcome, Exit.succeed(1));
        assert.equal(startedWorkers.length, priorCount + 1);
      } finally {
        posted.mockRestore();
        terminated.mockRestore();
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
