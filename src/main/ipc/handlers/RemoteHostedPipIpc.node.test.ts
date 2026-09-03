import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./RemoteHostedPipIpc";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("registers and releases the Remote Hosted PiP ingress with the Main Scope", () =>
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
    const remoteHostedPip = RemoteHostedPipRuntime.of({
      deleteTaskVisibility: () => Effect.void,
      diagnosticSnapshot: Effect.succeed([]),
      getAlwaysHide: () => false,
      observeCodexOccurrence: () => Effect.void,
      refresh: Effect.void,
      releaseChromeExtensionInstance: () => Effect.void,
      reportHostLayout: () => Effect.succeed(true),
      resolveBrowserPresentation: () => Effect.succeed(null),
      retireCodexThreads: () => Effect.void,
      retireLocalCodexHost: () => Effect.void,
      revisions: Stream.empty,
      setAlwaysHide: () => Effect.void,
      setMaxDisplaySize: () => Effect.void,
      setTaskVisibilities: () => Effect.void,
      setTaskVisibility: () => Effect.void,
      snapshot: Effect.succeed({
        activeTaskIds: [],
        alwaysHidden: false,
        retainedPresentationCount: 0,
        revision: 0,
        taskVisibilityActionAvailable: true,
        taskVisibilities: {},
      }),
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
            Layer.succeed(RemoteHostedPipRuntime, remoteHostedPip),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({
                all: () => [],
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );

    assert.isTrue(handlers.has("remote-hosted-pip:snapshot"));
    assert.isTrue(handlers.has("remote-hosted-pip:host-layout:report"));
    assert.isTrue(handlers.has("remote-hosted-pip:task-visibility:set"));
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(handlers.has("remote-hosted-pip:snapshot"));
  }),
);
