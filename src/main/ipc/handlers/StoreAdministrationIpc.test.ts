import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { MainShutdown, type MainShutdownReason } from "../../app/MainShutdown";
import { StoreAdministration } from "../../core-runtime/StoreAdministration";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./StoreAdministrationIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("owns Store administration ingress and commits restore shutdown atomically", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const shutdownReasons: MainShutdownReason[] = [];
    const shutdownRequested = yield* Deferred.make<void>();
    const finishShutdownRequest = yield* Deferred.make<void>();
    const shutdown = MainShutdown.of({
      request: (reason) =>
        Effect.gen(function* () {
          shutdownReasons.push(reason);
          yield* Deferred.succeed(shutdownRequested, undefined);
          yield* Deferred.await(finishShutdownRequest);
          return true;
        }),
      isRequested: Effect.succeed(false),
      awaitRequest: Effect.never,
      markRuntimeClosed: () => Effect.succeed(true),
      awaitRuntimeClosed: Effect.never,
    });
    const administration = StoreAdministration.of({
      listBackups: Effect.succeed([]),
      backupCapacity: Effect.succeed({
        availableBytes: 1_000_000,
        estimatedNextBackupBytes: 120,
        safetyMarginBytes: 512,
        totalReadyBytes: 0,
        manualReadyBytes: 0,
        automaticReadyBytes: 0,
        canCreate: true,
      }),
      snapshotStorageOptimization: Effect.succeed({
        optimizing: false,
        commitHead: 0,
        replayFloor: 0,
        pendingCommitMetadata: 0,
        pendingReceiptMetadata: 0,
        retainedCommitCount: 0,
        retainedDeliveryBytes: 0,
        retainedReceiptCount: 0,
        retainedReceiptBytes: 0,
        receiptFloorAt: null,
        lastPrunedCommit: 0,
        freelistPages: 0,
        reclaimableBytes: 0,
      }),
      createBackup: () => Effect.die("unused"),
      startBackup: () => Effect.die("unused"),
      backupJob: () => Effect.succeed(null),
      cancelBackup: () => Effect.die("unused"),
      deleteBackup: () => Effect.die("unused"),
      restoreBackup: (input) => Effect.succeed({ success: true, restoredBackupId: input.backupId }),
      pruneBackups: () => Effect.die("unused"),
      planMaintenance: () => Effect.die("unused"),
      runMaintenance: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(MainShutdown, shutdown),
            Layer.succeed(StoreAdministration, administration),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.deepStrictEqual([...handlers.keys()].sort(), [
      "backup:cancel",
      "backup:capacity:get",
      "backup:create",
      "backup:delete",
      "backup:job:get",
      "backup:list",
      "backup:restore",
      "backup:storage-optimization:get",
    ]);
    const frame = { url: "app://-/index.html" };
    const event = {
      sender: { getType: () => "window", id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const restoreFiber = yield* Effect.forkChild(
      handlers.get("backup:restore")!(event, {
        backupId: "backup-1",
        confirm: true,
      }),
    );
    yield* Deferred.await(shutdownRequested);
    const interruption = yield* Effect.forkChild(Fiber.interrupt(restoreFiber));
    assert.deepStrictEqual(shutdownReasons, [{ _tag: "StoreRestoreRelaunch" }]);
    yield* Deferred.succeed(finishShutdownRequest, undefined);
    yield* Fiber.join(interruption);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
