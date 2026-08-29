import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { ComputerUseSettingsRuntime } from "../../host-runtime/ComputerUseSettingsRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { live } from "./ComputerUseSettingsIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, unknown>;

it.effect("registers and releases Computer Use settings channels with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = ElectronIpc.of({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const settings = ComputerUseSettingsRuntime.of({
      getSnapshot: Effect.die("unused"),
      removeAppApproval: () => Effect.die("unused"),
      removeMessageApproval: () => Effect.die("unused"),
      setAlwaysHidePictureInPicture: () => Effect.die("unused"),
      setLockedUseEnabled: () => Effect.die("unused"),
      setSoundMode: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
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
            Layer.succeed(ComputerUseSettingsRuntime, settings),
          ),
        ),
      ),
      scope,
    );

    assert.deepEqual([...handlers.keys()].sort(), [
      "computer-use-settings-get",
      "computer-use-settings-remove-app-approval",
      "computer-use-settings-remove-message-approval",
      "computer-use-settings-set-always-hide-pip",
      "computer-use-settings-set-locked-use",
      "computer-use-settings-set-sound-mode",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
