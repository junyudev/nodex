import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { MainShutdown } from "../../app/MainShutdown";
import { StoreAdministration } from "../../core-runtime/StoreAdministration";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { isBoundedOperationId } from "../../../shared/operation-identity";

export class StoreAdministrationIpcError extends Schema.TaggedError<StoreAdministrationIpcError>()(
  "StoreAdministrationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | MainShutdown | StoreAdministration | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const administration = yield* StoreAdministration;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const shutdown = yield* MainShutdown;
    const windows = yield* WindowRuntime;
    const { handlePlainCommand, handleQuery } = ipc;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Store administration", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Store administration requires an active Nodex window");
          }
        },
        catch: (cause) =>
          new StoreAdministrationIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A, E>(operation: string, task: Effect.Effect<A, E>) =>
      task.pipe(Effect.mapError((cause) => new StoreAdministrationIpcError({ operation, cause })));

    yield* handleQuery("backup:list", (event) =>
      authorize(event).pipe(
        Effect.andThen(run("list-backups", administration.listBackups)),
        Effect.map((backups) => [...backups]),
      ),
    );
    yield* handleQuery("backup:capacity:get", (event) =>
      authorize(event).pipe(
        Effect.andThen(run("get-backup-capacity", administration.backupCapacity)),
      ),
    );
    yield* handleQuery("backup:storage-optimization:get", (event) =>
      authorize(event).pipe(
        Effect.andThen(
          run("get-snapshot-storage-optimization", administration.snapshotStorageOptimization),
        ),
      ),
    );
    yield* handlePlainCommand("backup:create", (event, command) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              if (!isBoundedOperationId(command.operationId)) {
                throw new TypeError("Backup operation identity is invalid");
              }
              return command;
            },
            catch: (cause) =>
              new StoreAdministrationIpcError({ operation: "create-backup", cause }),
          }),
        ),
        Effect.andThen((accepted) =>
          run(
            "create-backup",
            administration.startBackup({
              operationId: accepted.operationId,
              trigger: "manual",
              label: accepted.label,
            }),
          ),
        ),
      ),
    );
    yield* handleQuery("backup:job:get", (event, jobId) =>
      authorize(event).pipe(Effect.andThen(run("get-backup-job", administration.backupJob(jobId)))),
    );
    yield* handlePlainCommand("backup:cancel", (event, jobId) =>
      authorize(event).pipe(
        Effect.andThen(run("cancel-backup", administration.cancelBackup(jobId))),
      ),
    );
    yield* handlePlainCommand("backup:delete", (event, backupId) =>
      authorize(event).pipe(
        Effect.andThen(run("delete-backup", administration.deleteBackup(backupId))),
      ),
    );
    yield* handlePlainCommand("backup:restore", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("restore-backup", administration.restoreBackup(input))),
        Effect.flatMap((result) =>
          shutdown
            .request({ _tag: "StoreRestoreRelaunch" })
            .pipe(Effect.as(result), Effect.uninterruptible),
        ),
      ),
    );
  }),
);
