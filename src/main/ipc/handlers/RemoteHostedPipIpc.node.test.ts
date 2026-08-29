import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { live } from "./RemoteHostedPipIpc";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("registers and releases the Remote Hosted PiP ingress with the Main Scope", () =>
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
    const remoteHostedPip = RemoteHostedPipRuntime.of({
      getAlwaysHide: () => false,
      handleDesktopMessageFromView: () => Effect.void,
      isPrivacySettingsTerminationRequest: () => false,
      refresh: Effect.void,
      setAlwaysHide: () => Effect.void,
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
          ),
        ),
      ),
      scope,
    );

    assert.isTrue(handlers.has("codex-desktop:message-from-view"));
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(handlers.has("codex-desktop:message-from-view"));
  }),
);
