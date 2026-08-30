import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { AppUpdateRuntime } from "../../host-runtime/AppUpdateRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { live } from "./AppUpdateIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, unknown>;

it.effect("registers and releases app update ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const appUpdates = AppUpdateRuntime.of({
      check: Effect.die("unused"),
      currentSettings: Effect.succeed({ automaticChecksEnabled: true, channel: "stable" }),
      currentStatus: Effect.succeed({} as never),
      install: Effect.die("unused"),
      markApplicationReady: Effect.void,
      startAutomaticChecks: Effect.void,
      updateSettings: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AppUpdateRuntime, appUpdates),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              MainConfig,
              MainConfig.of({
                assistantStreamingDebug: false,
                appVersion: "test",
                arch: "arm64",
                argv: [],
                composerAppshotHelperPath: null,
                documentsPath: "/tmp/Documents",
                environment: {},
                environmentPath: null,
                homeDirectory: "/tmp",
                initialProjectsDirectory: null,
                isDefaultApp: false,
                isPackaged: false,
                nodexHome: "/tmp/nodex-test",
                profileSettingsPath: "/tmp/nodex-test/config.toml",
                platform: "darwin",
                profileId: "test",
                projectRootPath: "/repo",
                rendererUrl: "http://localhost:5173",
                resourcesPath: "/resources",
                runtimeBinaryPath: "/electron",
              }),
            ),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual([...handlers.keys()].sort(), [
      "app:update:check",
      "app:update:install",
      "app:update:status",
      "settings:app-updates:get",
      "settings:app-updates:update",
    ]);
    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
