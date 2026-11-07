// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { rebuildSessionMessageSearch } from "./SessionMessageSearchIndex.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// An older store adopts incremental vacuum once enough of it is free to repay a full rewrite.
export const VACUUM_ADOPTION_MIN_FREE_BYTES = 64 * 1024 * 1024;
const VACUUM_ADOPTION_MIN_FREE_SHARE = 0.25;
/** Metadata row present from before a VACUUM until its search index has been rebuilt. */
export const VACUUM_ADOPTION_ATTEMPT = "execution-store-vacuum-adoption";
const VACUUM_ADOPTION_RETRY_AFTER = Duration.days(7);

/**
 * Stores created before incremental vacuum only give pruned pages back through a full VACUUM,
 * which needs exclusive use of the file. Startup is the one moment nothing else is using it.
 *
 * A failed attempt leaves the store intact and starts normally. Its recorded attempt spaces out
 * retries, so a store too large to finish within the start budget still starts on the next try.
 */
const adoptIncrementalVacuum = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const attempts = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM orchestration_v2_projection_metadata
    WHERE projection_name = ${VACUUM_ADOPTION_ATTEMPT}`;
  // VACUUM may renumber rowids, and the contentless search index is keyed by them.
  const rebuildSearch = Effect.gen(function* () {
    yield* rebuildSessionMessageSearch;
    yield* sql`DELETE FROM orchestration_v2_projection_metadata
      WHERE projection_name = ${VACUUM_ADOPTION_ATTEMPT}`;
  });
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  if (mode[0]?.auto_vacuum === 2) {
    // Only a finished VACUUM changes this mode, so a remaining attempt lost its rebuild to a crash.
    if (attempts.length > 0) yield* rebuildSearch;
    return;
  }
  const now = yield* DateTime.now;
  const attemptedAt = attempts[0]?.updated_at;
  if (
    attemptedAt !== undefined &&
    DateTime.toEpochMillis(now) - Date.parse(attemptedAt) <
      Duration.toMillis(VACUUM_ADOPTION_RETRY_AFTER)
  )
    return;
  const databases = yield* sql<{
    readonly name: string;
    readonly file: string;
  }>`PRAGMA database_list`;
  const file = databases.find((database) => database.name === "main")?.file;
  if (!file) return;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const pageSize = size[0]?.page_size ?? 0;
  const totalBytes = (pages[0]?.page_count ?? 0) * pageSize;
  const freeBytes = (free[0]?.freelist_count ?? 0) * pageSize;
  if (
    freeBytes < VACUUM_ADOPTION_MIN_FREE_BYTES ||
    freeBytes < totalBytes * VACUUM_ADOPTION_MIN_FREE_SHARE
  )
    return;
  // VACUUM writes one temporary copy and, in WAL mode, a second copy through the WAL.
  const volume = yield* Effect.try(() => NodeFS.statfsSync(NodePath.dirname(file)));
  if (volume.bavail * volume.bsize < (totalBytes - freeBytes) * 2) {
    yield* Effect.logWarning("Not enough free disk space to compact the execution store");
    return;
  }
  yield* sql`INSERT INTO orchestration_v2_projection_metadata
      (projection_name, schema_version, last_sequence, updated_at)
    VALUES (${VACUUM_ADOPTION_ATTEMPT}, 0, 0, ${DateTime.formatIso(now)})
    ON CONFLICT(projection_name) DO UPDATE SET updated_at = excluded.updated_at`;
  yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
  yield* sql`VACUUM`;
  yield* rebuildSearch;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  yield* Effect.logInfo("Compacted the execution store", { totalBytes, freeBytes });
}).pipe(
  Effect.catch((cause) => Effect.logWarning("Execution store compaction failed", { cause })),
  Effect.withSpan("Sqlite.adoptIncrementalVacuum"),
);

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Pointer maps can only be chosen before the first table exists.
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    yield* adoptIncrementalVacuum;
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "nodex-agent-runtime",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
