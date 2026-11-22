/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeZlib from "node:zlib";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  /**
   * File databases only. The writer and two read lanes each run on their own worker thread, so
   * SQLite I/O, commits and checkpoints never block the calling thread. Reads require WAL and fall
   * back to the writer if a reader cannot start.
   */
  readonly workerConnections?: boolean;
  readonly workerStartupTimeout?: Duration.Input;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

// SqlClient masks transaction acquisition, so readOnly carries the caller's interruption policy.
const ReadOnly = Context.Reference<typeof Effect.interruptible | undefined>(
  "@nodex/runtime-shared/nodeSqliteClient/ReadOnly",
  { defaultValue: () => undefined },
);

/** Wrap the whole transaction; existing write transactions retain the writer, and writes on the reader fail as readonly. */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    restore(Effect.provideService(effect, ReadOnly, restore)),
  );

type ReadLaneName = "foreground" | "background";

const ReadLane = Context.Reference<ReadLaneName>("@nodex/runtime-shared/nodeSqliteClient/ReadLane", {
  defaultValue: () => "background",
});

/**
 * Reads inside take the lane kept for what a person is waiting to see, so a chat opening never
 * queues behind maintenance, search or other background reads on a worker-backed database.
 */
export const foregroundReads = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadLane, "foreground");

const writerLocks = new WeakMap<Client.SqlClient, Semaphore.Semaphore>();

/** Let a separate SQLite connection publish without making this client's writers block in SQLite. */
export const withExternalWriter = <A, E, R>(client: Client.SqlClient, effect: Effect.Effect<A, E, R>) =>
  writerLocks.get(client)!.withPermits(1)(Effect.uninterruptible(effect));

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // Named parameters may be callable objects; read data properties only to avoid invoking getters twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

const defineStoredTextFunctions = (db: NodeSqlite.DatabaseSync) => {
  // The read-only worker also registers this function when opening its connection.
  db.function("zstd_text", { deterministic: true }, (value) =>
    value === null ? null : NodeZlib.zstdDecompressSync(value as Uint8Array).toString("utf8"),
  );
};

// Inline worker source also runs in bundles and single-executable builds without module files.
const connectionWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { zstdDecompressSync } = require("node:zlib");
const reading = workerData.role === "reader";
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: reading,
    allowExtension: workerData.allowExtension,
  });
  next.function("zstd_text", { deterministic: true }, (value) =>
    value === null ? null : zstdDecompressSync(value).toString("utf8"),
  );
  next.exec("PRAGMA cache_size = -" + workerData.cacheKiB + ";");
  if (reading) {
    next.exec("PRAGMA busy_timeout = 5000;");
    // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
    const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
    if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  }
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({
    type: "unavailable",
    message: String(error && error.message ? error.message : error),
    code: error && error.code,
    errcode: error && error.errcode,
    errstr: error && error.errstr,
  });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", (message) => {
  if (message.type === "close") {
    try {
      statements.clear();
      db?.close();
    } catch {}
    db = undefined;
    parentPort.postMessage({ type: "closed" });
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers } = message;
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

/**
 * The writer keeps more of the store's index pages resident than each reader; together they stay
 * small next to the process's heap while sparing most cold page reads on a large store.
 */
const CACHE_KIB = { writer: 16 * 1024, reader: 8 * 1024 } as const;

type WorkerRole = keyof typeof CACHE_KIB;

interface WorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

interface FailureCodes {
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
}

type WorkerStartup =
  | { readonly type: "ready" }
  | ({ readonly type: "unavailable"; readonly message: string } & FailureCodes);

type WorkerReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
      } & FailureCodes;
    };

const workerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// Read-transaction cleanup succeeds after worker exit because it can no longer change anything.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

interface ConnectionWorker {
  readonly worker: NodeWorkerThreads.Worker;
  readonly connection: Connection;
  readonly started: Promise<WorkerStartup>;
  /** Closes the database before the thread ends, so its locks and WAL are released in order. */
  readonly close: () => Promise<void>;
}

/**
 * One SQLite connection on its own thread. A reader generation is disposable: interrupting a read
 * retires it, because SQLite may still be executing. The writer is never retired mid-statement:
 * like a synchronous call, a write runs to its reply, and statements keep the order they were sent.
 */
const startConnectionWorker = (
  options: SqliteClientConfig,
  role: WorkerRole,
  onStop: (worker: ConnectionWorker) => void,
): ConnectionWorker => {
  const worker = new NodeWorkerThreads.Worker(connectionWorkerSource, {
    eval: true,
    name: `sqlite-${role}`,
    workerData: {
      role,
      filename: options.filename,
      allowExtension: options.allowExtension ?? false,
      prepareCacheSize: options.prepareCacheSize ?? 200,
      cacheKiB: CACHE_KIB[role],
    },
  });
  let announce: (startup: WorkerStartup) => void = () => {};
  const started = new Promise<WorkerStartup>((resolve) => {
    announce = resolve;
  });
  let closed: () => void = () => {};
  const closing = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let nextRequestId = 0;
  let stoppedMessage: string | undefined;
  const pending = new Map<
    number,
    { readonly endsTransaction: boolean; readonly resume: (reply: WorkerReply) => void }
  >();
  const stop = (message: string) => {
    if (stoppedMessage !== undefined) return;
    stoppedMessage = message;
    announce({ type: "unavailable", message });
    closed();
    onStop(self);
    for (const [id, request] of pending) {
      request.resume(
        role === "reader" && request.endsTransaction
          ? { id, rows: [] }
          : { id, error: { operation: "execute", message } },
      );
    }
    pending.clear();
  };
  worker.on("message", (reply: WorkerReply | WorkerStartup | { readonly type: "closed" }) => {
    if ("type" in reply) {
      if (reply.type === "closed") closed();
      else announce(reply);
      if (pending.size === 0) worker.unref();
      return;
    }
    const request = pending.get(reply.id);
    if (request === undefined) return;
    pending.delete(reply.id);
    if (pending.size === 0) worker.unref();
    request.resume(reply);
  });
  const label = role === "reader" ? "Database reader" : "Database writer";
  worker.on("error", (cause) => stop(`${label} failed: ${cause.message}`));
  worker.on("exit", (code) => stop(`${label} exited with code ${code}`));

  const request = (input: WorkerRequest) =>
    Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
      const endsTransaction = role === "reader" && endsReadTransaction(input.sql);
      if (stoppedMessage !== undefined) {
        return endsTransaction
          ? Effect.succeed([])
          : Effect.fail(
              failed(new Error(stoppedMessage), workerFailureMessages.execute, "execute"),
            );
      }
      const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
      const call = Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
        const id = nextRequestId++;
        pending.set(id, {
          endsTransaction,
          resume: (reply) => {
            if ("rows" in reply) {
              resume(Effect.succeed(reply.rows));
              return;
            }
            const { operation, message, ...codes } = reply.error;
            resume(
              Effect.fail(
                failed(
                  Object.assign(new Error(message), codes),
                  workerFailureMessages[operation],
                  operation,
                ),
              ),
            );
          },
        });
        if (pending.size === 1) worker.ref();
        const cached = input.cached && !hasLargeBinding(input.params);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage({ id, safeIntegers, ...input, cached });
        if (role === "writer") return;
        return Effect.sync(() => {
          if (!pending.delete(id)) return;
          // SQLite may still be executing native code. Retire this generation before
          // releasing its lease so neither transaction cleanup nor the next read queues behind it.
          stop("Database reader query was interrupted");
          worker.unref();
          void worker.terminate();
        });
      });
      return role === "writer" ? Effect.uninterruptible(call) : call;
    });

  const connection = identity<Connection>({
    execute(sql, params, rowTransform) {
      const effect = request({ sql, params, cached: true, values: false, raw: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return request({ sql, params, cached: true, values: false, raw: true });
    },
    executeValues(sql, params) {
      return request({ sql, params, cached: true, values: true, raw: false });
    },
    executeValuesUnprepared(sql, params) {
      return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
    },
    executeUnprepared(sql, params, rowTransform) {
      // Read snapshots need deferred BEGIN; readonly connections reject IMMEDIATE and EXCLUSIVE.
      const statement = role === "reader" && /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
      const effect = request({
        sql: statement,
        params: params ?? [],
        cached: false,
        values: false,
        raw: false,
      });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  });
  const close = async () => {
    if (role === "writer" && stoppedMessage === undefined) {
      worker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage({ type: "close" });
      await closing;
    }
    await worker.terminate();
  };
  const self: ConnectionWorker = { worker, connection, started, close };
  return self;
};

const startupTimeoutOf = (options: SqliteClientConfig) =>
  Duration.fromInputUnsafe(options.workerStartupTimeout ?? Duration.seconds(10));

/** The primary connection of a worker-backed file database; it opens before the client exists. */
const makeWriter = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const openFailure = (message: string, codes?: FailureCodes) =>
    failed(Object.assign(new Error(message), codes), workerFailureMessages.open, "open");
  const writer = yield* Effect.acquireRelease(
    Effect.try({
      try: () => startConnectionWorker(options, "writer", () => {}),
      catch: (cause) => openFailure(String(cause)),
    }),
    (writer) => Effect.promise(writer.close),
  );
  const startupTimeout = startupTimeoutOf(options);
  const startup = yield* Effect.promise(() => writer.started).pipe(
    Effect.timeoutOption(startupTimeout),
  );
  if (Option.isNone(startup))
    return yield* openFailure(
      `the database writer did not open within ${Duration.toMillis(startupTimeout)} ms`,
    );
  if (startup.value.type === "unavailable") {
    const { type: _type, message, ...codes } = startup.value;
    return yield* openFailure(message, codes);
  }
  return writer.connection;
});

// Bind transactions to one worker; fail after its exit instead of resuming outside the transaction on a replacement.
const makeReader = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  let current: ConnectionWorker | undefined;
  let unavailable = false;

  const start = () => {
    current = startConnectionWorker(options, "reader", (stopped) => {
      if (current === stopped) current = undefined;
    });
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.close();
    }),
  );

  const startupTimeout = startupTimeoutOf(options);

  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
      if (unavailable) return Effect.succeed(undefined);
      unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable; reads use the main connection", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
    if (unavailable) return Effect.succeed(undefined);
    let reader: ConnectionWorker;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    return Effect.flatMap(
      Effect.withFiber((fiber) => {
        const restore = Context.get(fiber.context, ReadOnly) ?? identity;
        return restore(
          Effect.timeoutOption(
            Effect.promise(() => reader.started),
            startupTimeout,
          ),
        );
      }),
      (startup): Effect.Effect<Connection | undefined> =>
        // A late ready event must not hand out a worker retired by another acquire timeout.
        unavailable || current !== reader
          ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - The connection result distinguishes undefined from void.
            Effect.succeed(undefined)
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.succeed(reader.connection)
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () => {
        const opened = new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        });
        defineStoredTextFunctions(opened);
        return opened;
      },
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const fileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const threaded = options.workerConnections === true && fileDatabase && options.readonly !== true;
  const connection = threaded ? yield* makeWriter(options) : yield* makeConnection;
  /** A connection and its lease; a reader lane yields undefined once its reader cannot start. */
  interface Lane {
    readonly lock: Semaphore.Semaphore;
    readonly acquire: Effect.Effect<Connection | undefined>;
  }
  const writer: Lane = { lock: semaphore, acquire: Effect.succeed(connection) };
  const makeLane = Effect.gen(function* () {
    if (!threaded) return writer;
    return { lock: yield* Semaphore.make(1), acquire: yield* makeReader(options) };
  });
  const lanes: Readonly<Record<ReadLaneName, Lane>> = {
    foreground: yield* makeLane,
    background: yield* makeLane,
  };
  // Bind a reader generation only after taking its lease; waiters must not retain retired workers.
  const route = Effect.withFiber((fiber) =>
    Effect.succeed(
      Context.get(fiber.context, ReadOnly) ? lanes[Context.get(fiber.context, ReadLane)] : writer,
    ),
  );
  const writerLeases = Client.makeSqliteAcquirers({ connection: Effect.succeed(connection), semaphore });
  const acquire = Effect.flatMap(route, (target) => {
    if (target === writer) return Effect.withFiber((fiber) => (Context.get(fiber.context, ReadOnly) ?? identity)(writerLeases.acquirer));
    return Effect.uninterruptibleMask((restore) => Effect.withFiber((fiber) => {
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const interruptible = Context.get(fiber.context, ReadOnly) ?? restore;
      const lease = Effect.andThen(interruptible(target.lock.take(1)),
        Scope.addFinalizer(scope, target.lock.release(1)));
      return Effect.andThen(
        Effect.provideService(lease, Scheduler.PreventSchedulerYield, true),
        Effect.flatMap(target.acquire, (conn) => conn === undefined
          ? interruptible(writerLeases.acquirer)
          : Effect.succeed(conn)),
      );
    }));
  });
  const borrower: Borrower = (use) => Effect.flatMap(route, (target) =>
    target.lock.withPermits(1)(Effect.flatMap(target.acquire, (conn) => conn === undefined
      ? semaphore.withPermits(1)(use(connection))
      : use(conn))),
  );

  const client = yield* Client.make({
    driver: "sqlite-node",
    acquirer: acquire,
    borrower,
    compiler,
    transactionAcquirer: acquire,
    onCommitFailure: (conn) => conn === connection ? writerLeases.onCommitFailure(conn)
      : Effect.asVoid(conn.executeUnprepared("ROLLBACK", [], undefined)),
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  writerLocks.set(client, semaphore);
  return client;
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
