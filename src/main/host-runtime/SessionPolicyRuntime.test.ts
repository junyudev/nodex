import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { BrowserSessionPermissions } from "../browser/browser-session-permissions";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { assert, it } from "@effect/vitest";
import type { Session } from "electron";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { live } from "./SessionPolicyRuntime";

const permissions = () =>
  new BrowserSessionPermissions({
    findPage: () => null,
    publish: () => undefined,
    systemStatus: () => "unknown",
    openSystemSettings: async () => undefined,
  });

const fakeSession = () => {
  let permissionCheck: unknown = null;
  let permissionRequest: unknown = null;
  let beforeRequest: unknown = null;
  return {
    session: {
      setPermissionCheckHandler: (handler: unknown) => {
        permissionCheck = handler;
      },
      setPermissionRequestHandler: (handler: unknown) => {
        permissionRequest = handler;
      },
      webRequest: {
        onBeforeRequest: (handler: unknown) => {
          beforeRequest = handler;
        },
      },
    } as unknown as Session,
    permissionsInstalled: () => permissionCheck !== null && permissionRequest !== null,
    allInstalled: () =>
      permissionCheck !== null && permissionRequest !== null && beforeRequest !== null,
    request: (url: string, resourceType: string, webContentsId = 101) => {
      let result: { cancel?: boolean } | undefined;
      (
        beforeRequest as (details: unknown, callback: (value: { cancel?: boolean }) => void) => void
      )({ url, resourceType, webContentsId }, (value) => {
        result = value;
      });
      return result;
    },
    released: () =>
      permissionCheck === null && permissionRequest === null && beforeRequest === null,
  };
};

it.effect("installs policies before windows and removes them with the Main Scope", () =>
  Effect.gen(function* () {
    const appSession = fakeSession();
    const browserSession = fakeSession();
    const host = ElectronSessionHost.of({
      defaultSession: Effect.succeed(appSession.session),
      fromPartition: () => Effect.succeed(browserSession.session),
      hasOwnerWindow: () => true,
      scopedRegistration: (acquire: () => void, release: () => void) =>
        Effect.acquireRelease(Effect.sync(acquire), () => Effect.sync(release)),
    } as unknown as ElectronSessionHost["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronSessionHost, host),
            mainConfigLayer(),
            Layer.succeed(BrowserApplication, {
              permissions: permissions(),
              guest: { isNavigationRestricted: () => false, routeNavigation: () => false },
            } as unknown as BrowserApplication["Service"]),
            Layer.succeed(CodexGateway, {
              localHostId: "local",
              connectionChanges: () => Stream.empty,
              events: Stream.empty,
            } as unknown as CodexGateway["Service"]),
          ),
        ),
      ),
      scope,
    );
    assert.isTrue(appSession.permissionsInstalled());
    assert.isTrue(browserSession.allInstalled());

    yield* Scope.close(scope, Exit.void);
    assert.isTrue(appSession.released());
    assert.isTrue(browserSession.released());
  }),
);

it.effect(
  "composes managed network requirements with active main/subframe Agent restrictions",
  () =>
    Effect.gen(function* () {
      const appSession = fakeSession();
      const browserSession = fakeSession();
      let active = true;
      const calls: string[] = [];
      const host = ElectronSessionHost.of({
        defaultSession: Effect.succeed(appSession.session),
        fromPartition: () => Effect.succeed(browserSession.session),
        hasOwnerWindow: () => true,
        scopedRegistration: (acquire: () => void, release: () => void) =>
          Effect.acquireRelease(Effect.sync(acquire), () => Effect.sync(release)),
      } as unknown as ElectronSessionHost["Service"]);
      const browser = {
        permissions: permissions(),
        guest: {
          routeNavigation: () => false,
          isNavigationRestricted: (_id: number, url: string, resourceType: string) => {
            calls.push(`${resourceType}:${url}`);
            return active && url.startsWith("file:");
          },
        },
      } as unknown as BrowserApplication["Service"];
      const gateway = {
        localHostId: "local",
        events: Stream.empty,
        connectionChanges: () => Stream.make({ kind: "ready", hostId: "local", generation: 1 }),
        requestRawOnHost: () =>
          Effect.succeed({
            requirements: {
              application: { network: { enabled: true, domains: { "allowed.example": "allow" } } },
            },
          }),
      } as unknown as CodexGateway["Service"];
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronSessionHost, host),
              mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
              Layer.succeed(BrowserApplication, browser),
              Layer.succeed(CodexGateway, gateway),
            ),
          ),
        ),
        scope,
      );
      yield* Effect.yieldNow;
      assert.deepEqual(browserSession.request("file:///tmp/private", "mainFrame"), {
        cancel: true,
      });
      assert.deepEqual(browserSession.request("file:///tmp/private", "subFrame"), { cancel: true });
      assert.deepEqual(browserSession.request("file:///tmp/image.png", "image"), { cancel: false });
      assert.deepEqual(browserSession.request("data:text/html,Frame", "subFrame"), {
        cancel: false,
      });
      assert.deepEqual(browserSession.request("about:srcdoc", "subFrame"), { cancel: false });
      assert.deepEqual(browserSession.request("https://allowed.example/script.js", "script"), {
        cancel: false,
      });
      assert.deepEqual(browserSession.request("https://blocked.example/script.js", "script"), {
        cancel: true,
      });
      assert.deepEqual(browserSession.request("http://localhost:3000/", "mainFrame"), {
        cancel: true,
      });
      assert.deepEqual(browserSession.request("http://localhost:5173/", "mainFrame"), {
        cancel: false,
      });
      active = false;
      assert.deepEqual(browserSession.request("file:///tmp/private", "subFrame"), {
        cancel: false,
      });
      assert.include(calls, "subFrame:file:///tmp/private");
      yield* Scope.close(scope, Exit.void);
    }),
);
