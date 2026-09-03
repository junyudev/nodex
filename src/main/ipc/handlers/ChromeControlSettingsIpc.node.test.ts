import type { IpcMainInvokeEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { MainConfig } from "../../app/MainConfig";
import {
  ChromeControlRuntime,
  ChromeControlRuntimeError,
} from "../../host-runtime/ChromeControlRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ChromeControlSettingsIpc";
import { ChromeControlSettingsIpcError } from "./ChromeControlSettingsIpc";

type Handler = (
  event: IpcMainInvokeEvent,
) => Effect.Effect<unknown, ChromeControlRuntimeError | ChromeControlSettingsIpcError>;

it.effect("scope-owns Chrome settings IPC and rejects an untrusted sender before refresh", () =>
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
    let refreshCount = 0;
    const snapshot = {
      bundleSupported: true,
      extensionConnected: true,
      nativeHostInstalled: true,
      providerReady: true,
      reason: null,
      requested: true,
      revision: 1,
      status: "ready" as const,
    };
    const chrome = ChromeControlRuntime.of({
      available: () => true,
      changes: Stream.empty,
      focusPresentation: () => Effect.void,
      isConnectedInstance: () => true,
      refresh: Effect.sync(() => {
        refreshCount += 1;
        return snapshot;
      }),
      resolveBrowserIconPath: () => null,
      snapshot: () => snapshot,
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
            Layer.succeed(ChromeControlRuntime, chrome),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({ all: () => [] } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );

    const handler = handlers.get("chrome-control-settings-get");
    assert.isDefined(handler);
    const unauthorized = yield* Effect.exit(handler!({} as IpcMainInvokeEvent));
    assert.isTrue(Exit.isFailure(unauthorized));
    assert.strictEqual(refreshCount, 0);

    yield* Scope.close(scope, Exit.void);
    assert.isFalse(handlers.has("chrome-control-settings-get"));
  }),
);
