// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import {
  VACUUM_ADOPTION_ATTEMPT,
  VACUUM_ADOPTION_MIN_FREE_BYTES,
  WAL_SIZE_LIMIT_BYTES,
} from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nodex-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nodex-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  // About 25% more 4 KB rows than the limit holds, in one transaction.
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

    // The auto-checkpoint after the large commit copied every frame into the
    // database, so the next commit restarts the WAL and cuts the file back.
    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("creates new stores able to return free pages without a full rewrite", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nodex-sqlite-vacuum-"));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    assert.equal(mode[0]?.auto_vacuum, 2);
  }).pipe(
    Effect.provide(
      SqlitePersistence.layerFromPath(NodePath.join(tempDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("compacts an older store once pruning has freed enough of it", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "nodex-sqlite-adopt-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const open = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const mode = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`,
  ).pipe(Effect.map((rows) => rows[0]?.auto_vacuum));
  const attemptRows = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT updated_at FROM orchestration_v2_projection_metadata
      WHERE projection_name = ${VACUUM_ADOPTION_ATTEMPT}`,
  ).pipe(
    Effect.map((rows) => [...rows]),
    Effect.provide(open()),
  );
  const recordAttempt = (at: string) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`INSERT INTO orchestration_v2_projection_metadata
        (projection_name, schema_version, last_sequence, updated_at)
        VALUES (${VACUUM_ADOPTION_ATTEMPT}, 0, 0, ${at})
        ON CONFLICT(projection_name) DO UPDATE SET updated_at = excluded.updated_at`,
    );
  const findNeedle = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly rowid: number }>`
      SELECT rowid FROM orchestration_v2_session_message_search
      WHERE orchestration_v2_session_message_search MATCH '"needle"'`,
  );
  const fill = (bytes: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${Math.ceil(bytes / 65_536)})
         INSERT INTO filler SELECT zeroblob(65536) FROM n`,
      );
    });

  return Effect.gen(function* () {
    // A store that predates pointer maps already has a table when the layer first opens it.
    const legacy = new NodeSqlite.DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE filler(value BLOB)");
    legacy.close();

    yield* Effect.gen(function* () {
      // A little free space does not justify a rewrite.
      assert.equal(yield* mode, 0);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: "message",
        thread_id: "thread",
        run_id: null,
        node_id: null,
        role: "user",
        streaming: 0,
        created_at: "2026-11-07T00:00:00.000Z",
        updated_at: "2026-11-07T00:00:00.000Z",
        payload_json: JSON.stringify({ text: "findable needle" }),
      })}`;
      yield* fill(VACUUM_ADOPTION_MIN_FREE_BYTES / 4);
      yield* sql`DELETE FROM filler`;
    }).pipe(Effect.provide(open()));
    yield* Effect.gen(function* () {
      assert.equal(yield* mode, 0);
      const sql = yield* SqlClient.SqlClient;
      yield* fill(VACUUM_ADOPTION_MIN_FREE_BYTES * 2);
      yield* sql`DELETE FROM filler`;
      // A recent attempt that never finished holds off the next one, so a store that cannot
      // finish within the start budget still starts.
      yield* recordAttempt(DateTime.formatIso(yield* DateTime.now));
    }).pipe(Effect.provide(open()));
    yield* Effect.gen(function* () {
      assert.equal(yield* mode, 0);
    }).pipe(Effect.provide(open()));
    yield* TestClock.adjust("8 days");
    const before = NodeFS.statSync(dbPath).size;

    yield* Effect.gen(function* () {
      assert.equal(yield* mode, 2);
      assert.lengthOf(yield* findNeedle, 1);
    }).pipe(Effect.provide(open()));
    assert.isBelow(NodeFS.statSync(dbPath).size, before / 2);
    assert.deepEqual(yield* attemptRows, []);

    // A crash after VACUUM lost its search rebuild; the next start finishes it.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_session_message_search(orchestration_v2_session_message_search)
        VALUES('delete-all')`;
      yield* recordAttempt("2026-11-07T00:00:00.000Z");
    }).pipe(Effect.provide(open()));
    yield* Effect.gen(function* () {
      assert.lengthOf(yield* findNeedle, 1);
      assert.deepEqual(yield* attemptRows, []);
    }).pipe(Effect.provide(open()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
