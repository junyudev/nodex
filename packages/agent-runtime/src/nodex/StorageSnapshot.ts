// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Configuration from "../config.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import type { AgentRuntimeIdentity, AgentStorageSnapshot } from "./Interface.ts";
import type * as Providers from "./ProviderConfiguration.ts";

export class StorageSnapshotError extends Schema.TaggedError<StorageSnapshotError>()(
  "StorageSnapshotError",
  {
    message: Schema.String,
  },
) {}

interface AdmissionState {
  readonly frozen: boolean;
  readonly writers: number;
  readonly drained: Deferred.Deferred<void> | null;
}

/** Public writers drain before the independent SQL fence is acquired. Reads may wait behind it. */
export const makeAdmission = Effect.fnUntraced(function* () {
  const state = yield* Ref.make<AdmissionState>({ frozen: false, writers: 0, drained: null });
  const complete = Ref.modify(state, (current) => {
    const next = { ...current, writers: current.writers - 1 };
    return [next.writers === 0 ? next.drained : null, next] as const;
  }).pipe(
    Effect.flatMap((drained) =>
      drained === null ? Effect.void : Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
    ),
  );
  return {
    withWriter: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admitted = yield* Ref.modify(state, (current) =>
            current.frozen
              ? ([false, current] as const)
              : ([true, { ...current, writers: current.writers + 1 }] as const),
          );
          if (!admitted)
            return yield* new StorageSnapshotError({
              message: "A Profile snapshot is holding execution writes.",
            });
          return yield* restore(effect).pipe(Effect.ensuring(complete));
        }),
      ),
    freeze: Effect.gen(function* () {
      const drained = yield* Deferred.make<void>();
      const result = yield* Ref.modify(
        state,
        (
          current,
        ): readonly [{ readonly accepted: boolean; readonly writers: number }, AdmissionState] =>
          current.frozen
            ? ([{ accepted: false, writers: current.writers }, current] as const)
            : ([
                { accepted: true, writers: current.writers },
                { ...current, frozen: true, drained },
              ] as const),
      );
      if (!result.accepted)
        return yield* new StorageSnapshotError({
          message: "A Profile snapshot is already in progress.",
        });
      if (result.writers === 0) yield* Deferred.succeed(drained, undefined);
      yield* Deferred.await(drained);
    }),
    resume: Ref.update(state, (current) => ({ ...current, frozen: false, drained: null })),
  };
});

interface SnapshotPorts {
  readonly assertIdle: Effect.Effect<void, StorageSnapshotError>;
  readonly suspendNative: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly holdSql: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StorageSnapshotError, R>;
  readonly snapshot: Effect.Effect<AgentStorageSnapshot, StorageSnapshotError, Scope.Scope>;
}

/** The lease holder is process-scoped; releasing or disconnecting unwinds its SQL transaction. */
export const makeWithPorts = Effect.fn("AgentRuntime.StorageSnapshot")(function* (
  ports: SnapshotPorts,
) {
  const admission = yield* makeAdmission();
  const scope = yield* Effect.scope;
  const lane = yield* Semaphore.make(1);
  const active = yield* Ref.make<{
    readonly id: string;
    readonly release: Deferred.Deferred<void>;
    readonly fiber: Fiber.Fiber<void>;
  } | null>(null);
  const acquire = lane.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* Ref.get(active)) !== null)
        return yield* new StorageSnapshotError({
          message: "A Profile snapshot is already in progress.",
        });
      const id = randomUUID();
      const release = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<AgentStorageSnapshot, StorageSnapshotError>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Deferred.await(registered);
          yield* admission.freeze;
          yield* ports.assertIdle;
          yield* ports.suspendNative(
            ports.holdSql(
              Effect.gen(function* () {
                yield* ports.assertIdle;
                const snapshot = yield* ports.snapshot;
                yield* Deferred.succeed(ready, { ...snapshot, leaseId: id });
                yield* Deferred.await(release);
              }),
            ),
          );
        }),
      ).pipe(
        Effect.catch((error) => Deferred.fail(ready, error).pipe(Effect.asVoid)),
        Effect.catchCause(() =>
          Deferred.fail(
            ready,
            new StorageSnapshotError({ message: "Could not acquire the execution snapshot." }),
          ).pipe(Effect.asVoid),
        ),
        Effect.ensuring(admission.resume),
        Effect.ensuring(Ref.set(active, null)),
        Effect.forkIn(scope),
      );
      yield* Ref.set(active, { id, release, fiber });
      yield* Deferred.succeed(registered, undefined);
      return yield* Deferred.await(ready).pipe(
        Effect.catch((error) => Fiber.await(fiber).pipe(Effect.andThen(Effect.fail(error)))),
      );
    }),
  );
  return {
    ...admission,
    acquire,
    release: Effect.fn("AgentRuntime.releaseStorageSnapshot")(function* (id: string) {
      const current = yield* Ref.get(active);
      if (current === null || current.id !== id) return { released: false };
      yield* Deferred.succeed(current.release, undefined);
      yield* Fiber.await(current.fiber);
      return { released: true };
    }),
  };
});

export const make = Effect.fn("AgentRuntime.makeStorageSnapshot")(function* (
  identity: AgentRuntimeIdentity,
  providers: Effect.Success<ReturnType<typeof Providers.make>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const configuration = yield* Configuration.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const assertIdle = Effect.gen(function* () {
    if (!(yield* sessions.isSnapshotIdle))
      return yield* new StorageSnapshotError({
        message: "Execution must be idle before taking a Profile snapshot.",
      });
    const rows = yield* sql<{ readonly busy: number }>`SELECT
      EXISTS(SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')) OR
      EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox
        WHERE status NOT IN ('succeeded', 'failed', 'cancelled')) AS busy`;
    if (rows[0]?.busy !== 0)
      return yield* new StorageSnapshotError({
        message: "Execution must have no active or queued work before taking a Profile snapshot.",
      });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof StorageSnapshotError
        ? error
        : new StorageSnapshotError({ message: "Could not verify execution is idle." }),
    ),
  );
  return yield* makeWithPorts({
    assertIdle,
    suspendNative: (effect) =>
      providers.withSuspended(sessions.shutdown.pipe(Effect.andThen(effect))),
    holdSql: (effect) =>
      sql.withTransaction(effect).pipe(
        Effect.mapError((error) =>
          error instanceof StorageSnapshotError
            ? error
            : new StorageSnapshotError({
                message: "Could not acquire the execution database snapshot fence.",
              }),
        ),
      ),
    snapshot: Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: configuration.stateDir,
        prefix: ".profile-snapshot-",
      });
      const databasePath = path.join(directory, "agent-runtime.sqlite");
      yield* Effect.tryPromise(async () => {
        const source = new NodeSqlite.DatabaseSync(configuration.dbPath, { readOnly: true });
        try {
          await NodeSqlite.backup(source, databasePath);
        } finally {
          source.close();
        }
      });
      return {
        leaseId: "",
        runtimeId: identity.runtimeId,
        runtimeGeneration: identity.runtimeGeneration,
        sequence:
          (yield* sql<{ readonly sequence: number | null }>`
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          INDEXED BY idx_orchestration_events_application_high_water
          WHERE aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')
        `)[0]?.sequence ?? 0,
        databasePath,
        attachmentsPath: configuration.attachmentsDir,
        environmentIdPath: configuration.environmentIdPath,
      };
    }).pipe(
      Effect.mapError(
        () =>
          new StorageSnapshotError({ message: "Could not copy the execution database snapshot." }),
      ),
    ),
  });
});
