import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import type {
  StoreAdministrationApplyInput,
  StoreAdministrationApplyResult,
  StoreAdministrationRead,
  StoreAdministrationReadSnapshot,
} from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "./CoreModules";
import { coreRuntimeError } from "./CoreRuntimeError";
import { live, mapCoreStoreAdministrationEvent, StoreAdministration } from "./StoreAdministration";

const backup = {
  version: 2,
  backup_id: "core-backup",
  trigger: "auto" as const,
  label: "Before refactor",
  created_at: "2026-07-19T20:00:00.000Z",
  includes_assets: true,
  db_bytes: 100,
  assets_bytes: 20,
  total_bytes: 120,
  byte_length: 120,
};

const capacity = {
  available_bytes: 1_000_000,
  estimated_next_backup_bytes: 120,
  safety_margin_bytes: 512,
  total_ready_bytes: 120,
  manual_ready_bytes: 0,
  automatic_ready_bytes: 120,
  can_create: true,
};

const jobProgress = {
  database_copied_pages: 0,
  database_total_pages: 0,
  database_busy_retries: 0,
  asset_bytes_copied: 0,
  database_copy_ms: 0,
  asset_copy_ms: 0,
  validation_ms: 0,
  digest_ms: 0,
  publish_ms: 0,
  writer_held_ms: 0,
};

const readSnapshot = (
  value: StoreAdministrationReadSnapshot["value"],
): StoreAdministrationReadSnapshot => ({
  contract_version: 4,
  store_epoch: "epoch:test",
  commit_head: 4,
  value,
});

const committed = (
  value: Partial<StoreAdministrationApplyResult["outcome"]>,
): StoreAdministrationApplyResult => ({
  status: "committed",
  commit: {
    store_epoch: "epoch:test",
    commit_seq: 5,
    manifest_hash: "f".repeat(64),
  },
  receipt: {
    operation_id: "operation:test",
    duplicate: false,
    backup_id: value.backup_id ?? null,
    safety_backup_id: value.safety_backup_id ?? null,
  },
  outcome: {
    backup_id: null,
    safety_backup_id: null,
    completed_tasks: [],
    ...value,
  },
});

const makeHarness = () => {
  const reads: StoreAdministrationRead[] = [];
  const applies: StoreAdministrationApplyInput[] = [];
  const readResults: StoreAdministrationReadSnapshot[] = [];
  const applyResults: StoreAdministrationApplyResult[] = [];
  const administration: CoreModuleClients["administration"] = {
    read: (read) =>
      Effect.sync(() => {
        reads.push(read);
        const result = readResults.shift();
        if (!result) throw new Error("Missing Store Administration read result");
        return result;
      }),
    apply: (input) =>
      Effect.sync(() => {
        applies.push(input);
        const result = applyResults.shift();
        if (!result) throw new Error("Missing Store Administration apply result");
        return result;
      }),
  };
  const core = CoreModules.of({ administration } as unknown as CoreModuleClients);
  const layer = live.pipe(Layer.provide(Layer.succeed(CoreModules, core)));
  return { applies, applyResults, layer, reads, readResults };
};

it.effect("owns Backup CRUD and maintenance semantics on the typed Core Module", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.applyResults.push(committed({ backup_id: backup.backup_id }));
    harness.readResults.push(readSnapshot({ kind: "backup_jobs", jobs: [], coalesced_starts: [] }));
    harness.readResults.push(
      readSnapshot({
        kind: "backups",
        backups: {
          items: [backup],
          next_cursor: null,
          authority: { projection_revision: 4 },
        },
        capacity,
      }),
    );
    harness.applyResults.push(committed({ backup_id: backup.backup_id }));
    harness.applyResults.push(committed({}));
    harness.applyResults.push(committed({}));
    const context = yield* Layer.build(harness.layer);
    const administration = Context.get(context, StoreAdministration);

    assert.deepStrictEqual(
      yield* administration.createBackup({ trigger: "auto", label: "  Before refactor  " }),
      {
        version: 2,
        id: "core-backup",
        trigger: "auto",
        label: "Before refactor",
        createdAt: "2026-07-19T20:00:00.000Z",
        includesAssets: true,
        dbBytes: 100,
        assetsBytes: 20,
        totalBytes: 120,
      },
    );
    assert.deepStrictEqual(yield* administration.deleteBackup("core-backup"), {
      success: true,
      deletedBackupId: "core-backup",
    });
    yield* administration.pruneBackups(-4.8, 1_024.9);
    yield* administration.runMaintenance({
      tasks: ["document_revision_finalize", "block_retention"],
      blockRetentionCount: 37.9,
    });

    assert.deepStrictEqual(harness.reads, [
      { kind: "backup_jobs" },
      { kind: "backups", window: { after: null, first: 200 } },
    ]);
    assert.deepStrictEqual(
      harness.applies.map((input) => input.intent),
      [
        {
          kind: "create_backup",
          label: "Before refactor",
          include_assets: true,
          trigger: "auto",
        },
        { kind: "delete_backup", backup_id: "core-backup" },
        { kind: "prune_backups", retain_count: 0, retain_bytes: 1_024 },
        {
          kind: "run_maintenance",
          tasks: ["document_revision_finalize", "block_retention"],
          work_token: null,
          block_retention_count: 37,
        },
      ],
    );
  }),
);

it.effect("requires explicit confirmation and returns the safety Backup identity", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const context = yield* Layer.build(harness.layer);
    const administration = Context.get(context, StoreAdministration);

    const rejected = yield* administration
      .restoreBackup({ backupId: "core-backup", confirm: false })
      .pipe(Effect.result);
    assert.isTrue(rejected._tag === "Failure");
    assert.lengthOf(harness.applies, 0);

    harness.applyResults.push(
      committed({ backup_id: "core-backup", safety_backup_id: "safety-backup" }),
    );
    assert.deepStrictEqual(
      yield* administration.restoreBackup({
        backupId: "core-backup",
        confirm: true,
        createSafetyBackup: true,
      }),
      {
        success: true,
        restoredBackupId: "core-backup",
        safetyBackupId: "safety-backup",
      },
    );
    assert.deepStrictEqual(harness.applies[0]?.intent, {
      kind: "restore_backup",
      backup_id: "core-backup",
      create_safety_backup: true,
    });
  }),
);

it.effect("returns submitted before durable admission and durably coalesces later starts", () =>
  Effect.gen(function* () {
    const applyStarted = yield* Deferred.make<void>();
    const finishApply = yield* Deferred.make<void>();
    let activeOperationId: string | null = null;
    let createApplyCount = 0;
    let coalesceApplyCount = 0;
    const administrationClient: CoreModuleClients["administration"] = {
      apply: (input) =>
        Effect.gen(function* () {
          if (input.intent.kind === "coalesce_backup") {
            coalesceApplyCount += 1;
            return committed({ coalesced_backup_job_id: input.intent.active_job_id });
          }
          createApplyCount += 1;
          activeOperationId = input.operationId;
          yield* Deferred.succeed(applyStarted, undefined);
          yield* Deferred.await(finishApply);
          return committed({ backup_id: backup.backup_id });
        }),
      read: (read) => {
        if (read.kind === "backup_jobs") {
          return Effect.succeed(
            readSnapshot({
              kind: "backup_jobs",
              coalesced_starts: [],
              jobs: activeOperationId
                ? [
                    {
                      job_id: activeOperationId,
                      operation_id: activeOperationId,
                      state: "running",
                      phase: "database_snapshot",
                      completed_units: 1,
                      total_units: 7,
                      started_at_ms: 10,
                      updated_at_ms: 20,
                      label: "Background",
                      include_assets: true,
                      trigger: "manual",
                      backup_id: backup.backup_id,
                      error: null,
                      progress: jobProgress,
                    },
                  ]
                : [],
            }),
          );
        }
        if (read.kind === "maintenance_status") {
          return Effect.succeed(
            readSnapshot({
              kind: "maintenance_status",
              active: true,
              operation_id: null,
              phase: "validation",
            }),
          );
        }
        return Effect.succeed(
          readSnapshot({
            kind: "backups",
            backups: {
              items: [backup],
              next_cursor: null,
              authority: { projection_revision: 4 },
            },
            capacity,
          }),
        );
      },
    };
    const layer = live.pipe(
      Layer.provide(
        Layer.succeed(
          CoreModules,
          CoreModules.of({ administration: administrationClient } as unknown as CoreModuleClients),
        ),
      ),
    );
    const context = yield* Layer.build(layer);
    const administration = Context.get(context, StoreAdministration);

    const submitted = yield* administration.startBackup({
      operationId: "electron:administration:create-backup-job:test",
      label: "Background",
    });
    assert.strictEqual(submitted.kind, "submitted");
    if (submitted.kind !== "submitted") return assert.fail("expected submitted Backup job");
    assert.strictEqual(submitted.job.state, "queued");
    assert.strictEqual(submitted.job.phase, "queued");
    yield* Deferred.await(applyStarted);

    const retried = yield* administration.startBackup({
      operationId: submitted.operationId,
      label: "Background",
    });
    assert.strictEqual(retried.kind, "submitted");
    assert.strictEqual(retried.operationId, submitted.operationId);
    assert.strictEqual(createApplyCount, 1);

    const coalescedOperationId = "electron:administration:create-backup-job:coalesced";
    const coalesced = yield* administration.startBackup({
      operationId: coalescedOperationId,
      label: "Coalesced",
    });
    assert.deepStrictEqual(coalesced, {
      kind: "already_running",
      operationId: coalescedOperationId,
      activeJobId: submitted.operationId,
    });
    assert.strictEqual(coalesceApplyCount, 1);

    const running = yield* administration.backupJob(submitted.operationId);
    assert.isNotNull(running);
    assert.include(["queued", "running"], running?.state);

    yield* Deferred.succeed(finishApply, undefined);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      yield* Effect.yieldNow;
      const completed = yield* administration.backupJob(submitted.operationId);
      if (completed?.state !== "completed") continue;
      assert.strictEqual(completed.backup?.id, "core-backup");
      const coalescedRetry = yield* administration.startBackup({
        operationId: coalescedOperationId,
        label: "Coalesced",
      });
      assert.deepStrictEqual(coalescedRetry, coalesced);
      assert.strictEqual(coalesceApplyCount, 1);
      assert.strictEqual(createApplyCount, 1);
      return;
    }
    assert.fail("snapshot job did not publish its completion");
  }),
);

it.effect("replays a lost coalescence response instead of starting the requested snapshot", () =>
  Effect.gen(function* () {
    const activeOperationId = "electron:administration:create-backup-job:active";
    const coalescedOperationId = "electron:administration:create-backup-job:lost-response";
    const activeApplyStarted = yield* Deferred.make<void>();
    const finishActiveApply = yield* Deferred.make<void>();
    let durableAliasTarget: string | null = null;
    let createdSnapshots = 0;
    const administrationClient: CoreModuleClients["administration"] = {
      apply: (input) =>
        Effect.gen(function* () {
          if (input.intent.kind === "coalesce_backup") {
            durableAliasTarget = input.intent.active_job_id;
            return yield* coreRuntimeError({
              operation: "administration.apply",
              reason: "transport-loss",
              retryable: true,
            });
          }
          if (input.operationId === coalescedOperationId && durableAliasTarget) {
            return committed({ coalesced_backup_job_id: durableAliasTarget });
          }
          createdSnapshots += 1;
          yield* Deferred.succeed(activeApplyStarted, undefined);
          yield* Deferred.await(finishActiveApply);
          return committed({ backup_id: backup.backup_id });
        }),
      read: (read) => {
        if (read.kind === "backup_jobs") {
          return Effect.succeed(
            readSnapshot({
              kind: "backup_jobs",
              coalesced_starts: [],
              jobs: [],
            }),
          );
        }
        return Effect.succeed(
          readSnapshot({
            kind: "backups",
            backups: {
              items: [backup],
              next_cursor: null,
              authority: { projection_revision: 4 },
            },
            capacity,
          }),
        );
      },
    };
    const context = yield* Layer.build(
      live.pipe(
        Layer.provide(
          Layer.succeed(
            CoreModules,
            CoreModules.of({
              administration: administrationClient,
            } as unknown as CoreModuleClients),
          ),
        ),
      ),
    );
    const administration = Context.get(context, StoreAdministration);

    yield* administration.startBackup({ operationId: activeOperationId });
    yield* Deferred.await(activeApplyStarted);
    const lostResponse = yield* Effect.exit(
      administration.startBackup({ operationId: coalescedOperationId }),
    );
    assert.isTrue(Exit.isFailure(lostResponse));
    assert.strictEqual(durableAliasTarget, activeOperationId);

    yield* Deferred.succeed(finishActiveApply, undefined);
    let activeCompleted = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      yield* Effect.yieldNow;
      if ((yield* administration.backupJob(activeOperationId))?.state !== "completed") continue;
      activeCompleted = true;
      break;
    }
    assert.isTrue(activeCompleted);

    const retried = yield* administration.startBackup({ operationId: coalescedOperationId });
    assert.strictEqual(retried.kind, "submitted");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      yield* Effect.yieldNow;
      const replayed = yield* administration.backupJob(coalescedOperationId);
      if (replayed?.jobId !== activeOperationId) continue;
      assert.strictEqual(replayed.state, "completed");
      assert.strictEqual(createdSnapshots, 1);
      return;
    }
    assert.fail("lost coalescence response did not replay its durable target");
  }),
);

it.effect("resumes a durable Core snapshot job when Main starts again", () =>
  Effect.gen(function* () {
    const applyStarted = yield* Deferred.make<void>();
    const finishApply = yield* Deferred.make<void>();
    const operationId = "electron:administration:create-backup-job:recovered";
    const coalescedOperationId = "electron:administration:create-backup-job:coalesced-retry";
    let applyCount = 0;
    const durableJob = {
      job_id: operationId,
      operation_id: operationId,
      state: "running" as const,
      phase: "validation" as const,
      completed_units: 3,
      total_units: 7,
      started_at_ms: 10,
      updated_at_ms: 20,
      label: "Recovered",
      include_assets: true,
      trigger: "manual" as const,
      backup_id: backup.backup_id,
      error: null,
      progress: jobProgress,
    };
    const administrationClient: CoreModuleClients["administration"] = {
      apply: () =>
        Effect.gen(function* () {
          applyCount += 1;
          yield* Deferred.succeed(applyStarted, undefined);
          yield* Deferred.await(finishApply);
          return committed({ backup_id: backup.backup_id });
        }),
      read: (read) => {
        if (read.kind === "backup_jobs") {
          return Effect.succeed(
            readSnapshot({
              kind: "backup_jobs",
              jobs: [durableJob],
              coalesced_starts: [
                {
                  operation_id: coalescedOperationId,
                  active_job_id: operationId,
                },
              ],
            }),
          );
        }
        return Effect.succeed(
          readSnapshot({
            kind: "backups",
            backups: {
              items: [backup],
              next_cursor: null,
              authority: { projection_revision: 4 },
            },
            capacity,
          }),
        );
      },
    };
    const layer = live.pipe(
      Layer.provide(
        Layer.succeed(
          CoreModules,
          CoreModules.of({ administration: administrationClient } as unknown as CoreModuleClients),
        ),
      ),
    );
    const context = yield* Layer.build(layer);
    const administration = Context.get(context, StoreAdministration);

    yield* Deferred.await(applyStarted);
    assert.deepStrictEqual(
      yield* administration.startBackup({ operationId: coalescedOperationId }),
      {
        kind: "already_running",
        operationId: coalescedOperationId,
        activeJobId: operationId,
      },
    );
    assert.strictEqual(applyCount, 1);
    const recovered = yield* administration.backupJob(operationId);
    assert.strictEqual(recovered?.phase, "validation");
    yield* Deferred.succeed(finishApply, undefined);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      yield* Effect.yieldNow;
      if ((yield* administration.backupJob(operationId))?.state === "completed") return;
    }
    assert.fail("recovered snapshot job did not finish");
  }),
);

it("maps Store Administration invalidation without another event owner", () => {
  const packet = createCoreLocalCommitFixture({
    commitSeq: 5,
    storeEpoch: "epoch:test",
    operationId: "operation:backup",
    committedAt: "2026-07-19T20:00:00.000Z",
    payload: {
      module: "store_administration",
      library_id: "library-1",
      event: {
        kind: "store_administration_changed",
        operation: "create_backup",
        backup_ids: ["core-backup"],
        readiness_changed: false,
      },
    },
    canonicalHash: "0".repeat(64),
  });
  assert.deepStrictEqual(mapCoreStoreAdministrationEvent(packet.atoms[0]!), {
    backupIds: ["core-backup"],
    readinessChanged: false,
  });
});
