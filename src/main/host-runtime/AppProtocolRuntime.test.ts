import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { Protocol, Session } from "electron";
import { APP_PROTOCOL_SCHEME } from "../../shared/app-protocol";
import { MainConfig } from "../app/MainConfig";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { live } from "./AppProtocolRuntime";

it.effect("owns application protocol handlers with the Main Scope", () =>
  Effect.gen(function* () {
    const handled = new Set<string>();
    let gateInstalled = false;
    const defaultSession = {
      webRequest: {
        onBeforeRequest: (...args: unknown[]) => {
          gateInstalled = args.length > 1;
        },
      },
    } as unknown as Session;
    const protocol = {
      handle: (scheme: string) => {
        handled.add(scheme);
      },
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle: (scheme: string) => {
        handled.delete(scheme);
      },
    } as unknown as Protocol;
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(
              ElectronSessionHost,
              ElectronSessionHost.of({
                defaultSession: Effect.succeed(defaultSession),
                fromPartition: () => Effect.die("unused"),
                hasOwnerWindow: () => false,
                protocol,
                scopedRegistration: () => Effect.void,
              }),
            ),
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

    assert.isTrue(handled.has(APP_PROTOCOL_SCHEME));
    assert.isTrue(gateInstalled);
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(handled.has(APP_PROTOCOL_SCHEME));
    assert.isFalse(gateInstalled);
  }),
);
