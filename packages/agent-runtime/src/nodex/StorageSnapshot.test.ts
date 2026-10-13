// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { makeAdmission, makeWithPorts, StorageSnapshotError } from "./StorageSnapshot.ts";

const emptySnapshot = {
  leaseId: "",
  runtimeId: "runtime:test",
  runtimeGeneration: "generation:test",
  sequence: 7,
  databasePath: "/snapshot/agent-runtime.sqlite",
  attachmentsPath: "/profile/attachments",
  environmentIdPath: "/profile/environment-id",
};

it.effect("drains admitted writers and refuses new writes until the lease ends", () =>
  Effect.gen(function* () {
    const admission = yield* makeAdmission();
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const writer = yield* admission
      .withWriter(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))))
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const frozen = yield* admission.freeze.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(frozen.pollUnsafe()).toBeUndefined();
    expect((yield* admission.withWriter(Effect.void).pipe(Effect.flip))._tag).toBe(
      "StorageSnapshotError",
    );
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(writer);
    yield* Fiber.join(frozen);
    expect((yield* admission.withWriter(Effect.void).pipe(Effect.flip))._tag).toBe(
      "StorageSnapshotError",
    );
    yield* admission.resume;
    expect(yield* admission.withWriter(Effect.succeed("resumed"))).toBe("resumed");
  }),
);

it.effect("unwinds failed acquisition before admitting the next snapshot or writer", () =>
  Effect.gen(function* () {
    const busy = yield* Ref.make(true);
    let fences = 0;
    const resource = yield* makeWithPorts({
      assertIdle: Ref.get(busy).pipe(
        Effect.flatMap((value) =>
          value
            ? Effect.fail(new StorageSnapshotError({ message: "Native background work remains." }))
            : Effect.void,
        ),
      ),
      suspendNative: (effect) => effect,
      holdSql: (effect) =>
        Effect.sync(() => {
          fences += 1;
        }).pipe(Effect.andThen(effect)),
      snapshot: Effect.succeed(emptySnapshot),
    });
    expect((yield* resource.acquire.pipe(Effect.flip)).message).toBe(
      "Native background work remains.",
    );
    expect(fences).toBe(0);
    expect(yield* resource.withWriter(Effect.succeed("admitted"))).toBe("admitted");
    yield* Ref.set(busy, false);
    const lease = yield* resource.acquire;
    expect(fences).toBe(1);
    expect((yield* resource.acquire.pipe(Effect.flip)).message).toBe(
      "A Profile snapshot is already in progress.",
    );
    expect(yield* resource.release("foreign-lease")).toEqual({ released: false });
    expect(yield* resource.release(lease.leaseId)).toEqual({ released: true });
    expect(yield* resource.release(lease.leaseId)).toEqual({ released: false });
  }),
);

const withDatabase = (closeScope: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-snapshot-fence-" });
    const filename = path.join(home, "state.sqlite");
    const external = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    yield* Effect.sync(() =>
      external.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE counters(value INTEGER); INSERT INTO counters VALUES (0)",
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const leaseScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(leaseScope, Exit.void));
      const resource = yield* makeWithPorts({
        assertIdle: Effect.void,
        suspendNative: (effect) => effect,
        holdSql: (effect) =>
          sql
            .withTransaction(effect)
            .pipe(Effect.mapError(() => new StorageSnapshotError({ message: "Lock failed." }))),
        snapshot: Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({ directory: home });
          const databasePath = path.join(directory, "copy.sqlite");
          yield* Effect.tryPromise(async () => {
            const source = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
            try {
              await NodeSqlite.backup(source, databasePath);
            } finally {
              source.close();
            }
          }).pipe(Effect.mapError(() => new StorageSnapshotError({ message: "Copy failed." })));
          return { ...emptySnapshot, databasePath };
        }).pipe(Effect.orDie),
      }).pipe(Effect.provideService(Scope.Scope, leaseScope));
      const lease = yield* resource.acquire;
      yield* Effect.sync(() => {
        expect(() => external.exec("UPDATE counters SET value=99")).toThrow(/locked/);
        const copied = new NodeSqlite.DatabaseSync(lease.databasePath, { readOnly: true });
        try {
          expect(copied.prepare("SELECT value FROM counters").get()).toEqual({ value: 0 });
        } finally {
          copied.close();
        }
      });
      const started = yield* Deferred.make<void>();
      const writer = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(sql`UPDATE counters SET value=1`),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      expect(writer.pollUnsafe()).toBeUndefined();
      if (closeScope) yield* Scope.close(leaseScope, Exit.void);
      else expect(yield* resource.release(lease.leaseId)).toEqual({ released: true });
      yield* Fiber.join(writer);
      expect(yield* sql`SELECT value FROM counters`.values).toEqual([[1]]);
      expect(yield* fs.exists(lease.databasePath)).toBe(false);
      yield* Effect.sync(() => external.exec("UPDATE counters SET value=2"));
      expect(yield* resource.withWriter(Effect.succeed("resumed"))).toBe("resumed");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer));

it.live("holds all SQL writers and external writers while copying a consistent database", () =>
  withDatabase(false),
);
it.live("releases the SQL fence and temporary snapshot when its owning Scope closes", () =>
  withDatabase(true),
);
