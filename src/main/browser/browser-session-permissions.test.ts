import { describe, expect, test, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BrowserSessionPermissions,
  type BrowserPermissionPage,
} from "./browser-session-permissions";
import {
  makeBrowserPermissionStore,
  type BrowserPermissionStore,
} from "./browser-permission-store";
import { makeBrowserSiteInfoRuntime } from "./browser-site-info-provider";
import type {
  BrowserPermissionAction,
  BrowserPermissionPrompt,
  BrowserSitePermissionName,
} from "../../shared/browser/browser-permissions";
import { allowsBrowserSessionRequest } from "./browser-session-request-policy";
import {
  makeBrowserRuntimeRegistry,
  type BrowserAuthorizedAttachment,
} from "./browser-runtime-registry";
import {
  makeBrowserSidebarRoutePartition,
  type BrowserSidebarHostRouteIdentity,
  type BrowserSidebarBrowserUseStateSnapshot,
  type BrowserSidebarStateSnapshot,
  type BrowserSidebarTabSnapshot,
  type BrowserUseTabState,
} from "../../shared/browser-sidebar";
import {
  consumePendingBrowserWebviewAttachment,
  decideBrowserWebviewAttachment,
  forceBrowserPageGuestPreferences,
  registerPendingBrowserWebviewAttachment,
} from "./browser-webview-attachment-policy";
import {
  filterBrowserStateForViewScope,
  filterBrowserUseStateForViewScope,
} from "./browser-event-routing";
import * as Fiber from "effect/Fiber";
import { makeBrowserPageEmulationRuntime } from "./browser-page-emulation";

describe("browser-session-permissions", () => {
  describe("browser-session-permissions", () => {
    const identity = {
      browserConversationId: "conversation",
      browserViewScopeId: "scope",
      browserTabId: "tab",
    };
    const origin = "https://example.com";
    const makeFixture = (store: BrowserPermissionStore) => {
      let page: BrowserPermissionPage | null = {
        ...identity,
        rendererInstanceId: "renderer",
        mountGeneration: 2,
        hostGeneration: 3,
        ownerWebContentsId: 7,
        webContentsId: 101,
        url: `${origin}/page`,
        navigationVersion: 1,
        presented: true,
        hasUserGesture: false,
      };
      let prompts: BrowserPermissionPrompt[] = [];
      const results: boolean[] = [];
      const opened: BrowserSitePermissionName[] = [];
      const osDenied = new Set<BrowserSitePermissionName>();
      const runtime = new BrowserSessionPermissions(
        {
          findPage: (id) => (id === page?.webContentsId ? page : null),
          publish: (_identity, values) => {
            prompts = values;
          },
          systemStatus: (permission) => (osDenied.has(permission) ? "denied" : "granted"),
          openSystemSettings: async (permission) => {
            opened.push(permission);
          },
        },
        store,
      );
      const request = (
        permission: Parameters<BrowserSessionPermissions["request"]>[1],
        details: Partial<Parameters<BrowserSessionPermissions["request"]>[3]> = {},
      ) => {
        runtime.request({ id: 101 } as never, permission, (result) => results.push(result), {
          isMainFrame: true,
          requestingUrl: `${origin}/page`,
          ...details,
        });
      };
      const check = (
        permission: Parameters<BrowserSessionPermissions["check"]>[1],
        mediaType?: "video" | "audio" | "unknown",
      ) =>
        runtime.check({ id: 101 } as never, permission, origin, { isMainFrame: true, mediaType });
      const prompt = () => {
        const value = prompts.at(-1);
        if (!value) throw new Error("Expected a permission prompt");
        return value;
      };
      const response = (action: BrowserPermissionAction) => ({
        ...identity,
        type: "respond-permission" as const,
        promptId: prompt().id,
        mountGeneration: 2,
        action,
      });
      const patchPage = (patch: Partial<BrowserPermissionPage>) => {
        if (!page) throw new Error("Page is unavailable");
        page = { ...page, ...patch };
      };
      return {
        runtime,
        request,
        check,
        prompt,
        response,
        results,
        opened,
        osDenied,
        patchPage,
        losePage: () => {
          page = null;
        },
        prompts: () => prompts,
      };
    };

    const withStore = <A, E, R>(
      run: (store: BrowserPermissionStore, filePath: string) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-permissions-"))),
        (root) =>
          Effect.gen(function* () {
            const filePath = path.join(root, "browser-permissions.json");
            return yield* run(yield* makeBrowserPermissionStore(filePath), filePath);
          }),
        (root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true })),
      );

    it.layer(NodeServices.layer)("Browser permissions", (it) => {
      it.effect(
        "combines camera and microphone in one origin-attributed prompt and holds the callback",
        () =>
          withStore((store) =>
            Effect.sync(() => {
              const fixture = makeFixture(store);
              fixture.request("media", {
                mediaTypes: ["video", "audio"],
                securityOrigin: "https://frame.example",
              });
              assert.deepEqual(fixture.results, []);
              assert.lengthOf(fixture.prompts(), 1);
              assert.deepInclude(fixture.prompt(), {
                origin: "https://frame.example",
                embeddingOrigin: origin,
                permissions: [{ name: "camera" }, { name: "microphone" }],
                actions: ["allow", "allow-this-time", "deny", "dismiss"],
                variant: "permission",
              });
              fixture.runtime.dispose();
              assert.deepEqual(fixture.results, [false]);
            }),
          ),
      );

      it.effect(
        "grants browser-default categories without prompting and requires activation for clipboard auto-grants",
        () =>
          withStore((store) =>
            Effect.sync(() => {
              const fixture = makeFixture(store);
              for (const permission of [
                "fullscreen",
                "pointerLock",
                "keyboardLock",
                "mediaKeySystem",
                "screen-wake-lock",
                "sensors",
                "background-sync",
                "background-fetch",
                "payment-handler",
              ] as const) {
                fixture.request(permission);
                assert.isTrue(fixture.check(permission));
              }
              assert.deepEqual(fixture.results, Array(9).fill(true));
              assert.isEmpty(fixture.prompts());
              fixture.request("clipboard-sanitized-write");
              assert.strictEqual(fixture.prompt().permissions[0]?.name, "clipboard-write");
              fixture.runtime.release(101);
              fixture.patchPage({ hasUserGesture: true });
              fixture.request("clipboard-sanitized-write", { isMainFrame: false });
              assert.strictEqual(fixture.results.at(-1), true);
              assert.isEmpty(fixture.prompts());
              assert.isTrue(fixture.check("clipboard-sanitized-write"));
            }),
          ),
      );

      it.effect("denies device and display capture requests without a chooser", () =>
        withStore((store) =>
          Effect.sync(() => {
            const fixture = makeFixture(store);
            for (const permission of [
              "hid",
              "serial",
              "usb",
              "display-capture",
              "speaker-selection",
              "fileSystem",
              "unknown",
            ] as const)
              fixture.request(permission);
            assert.deepEqual(fixture.results, Array(7).fill(false));
            assert.isEmpty(fixture.prompts());
          }),
        ),
      );

      for (const action of ["allow", "deny", "dismiss", "allow-this-time"] as const) {
        it.effect(`${action} resolves once and applies the correct persistence lifetime`, () =>
          withStore((store, filePath) =>
            Effect.gen(function* () {
              const fixture = makeFixture(store);
              fixture.request("media", { mediaTypes: ["video", "audio"] });
              const response = fixture.response(action);
              assert.deepEqual(yield* fixture.runtime.respond(response, 7), { ok: true });
              assert.deepEqual(fixture.results, [
                action === "allow" || action === "allow-this-time",
              ]);
              assert.isEmpty(fixture.prompts());
              assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
              const reloaded = yield* makeBrowserPermissionStore(filePath);
              const persisted =
                action === "allow" ? "allow" : action === "deny" ? "block" : undefined;
              assert.strictEqual(reloaded.get(origin, "camera"), persisted);
              assert.strictEqual(reloaded.get(origin, "microphone"), persisted);
              assert.strictEqual(
                fixture.check("media", "audio"),
                action === "allow" || action === "allow-this-time",
              );
              fixture.request("media", { mediaTypes: ["audio"] });
              if (action === "dismiss") {
                assert.lengthOf(fixture.prompts(), 1);
                fixture.runtime.dispose();
                return;
              }
              assert.lengthOf(fixture.results, 2);
              assert.isEmpty(fixture.prompts());
              fixture.runtime.navigation(101, `${origin}/another-page`);
              assert.strictEqual(fixture.check("media", "video"), action !== "deny");
              fixture.runtime.navigation(101, "https://other.example/");
              assert.strictEqual(fixture.check("media", "video"), action === "allow");
            }),
          ),
        );
      }

      it.effect(
        "rejects foreign owners, tabs, prompt IDs, generations and navigation versions",
        () =>
          withStore((store) =>
            Effect.gen(function* () {
              const fixture = makeFixture(store);
              fixture.request("notifications");
              const response = fixture.response("allow");
              for (const invalid of [
                { ...response, promptId: "foreign" },
                { ...response, browserTabId: "foreign" },
                { ...response, browserConversationId: "foreign" },
                { ...response, browserViewScopeId: "foreign" },
                { ...response, mountGeneration: 1 },
              ])
                assert.isFalse((yield* fixture.runtime.respond(invalid, 7)).ok);
              assert.isFalse((yield* fixture.runtime.respond(response, 8)).ok);
              for (const patch of [
                { presented: false },
                { navigationVersion: 2 },
                { rendererInstanceId: "new" },
                { mountGeneration: 3 },
                { hostGeneration: 4 },
                { ownerWebContentsId: 8 },
              ]) {
                fixture.patchPage(patch);
                assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
                fixture.patchPage({
                  presented: true,
                  navigationVersion: 1,
                  rendererInstanceId: "renderer",
                  mountGeneration: 2,
                  hostGeneration: 3,
                  ownerWebContentsId: 7,
                });
              }
              assert.isUndefined(store.get(origin, "notifications"));
              assert.isEmpty(fixture.results);
              fixture.losePage();
              assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
              fixture.runtime.dispose();
              assert.deepEqual(fixture.results, [false]);
            }),
          ),
      );

      it.effect(
        "dismisses pending callbacks on navigation, close and teardown without remembering a block",
        () =>
          withStore((store) =>
            Effect.sync(() => {
              const fixture = makeFixture(store);
              fixture.request("notifications");
              fixture.runtime.navigation(101, `${origin}/next`);
              fixture.request("geolocation");
              fixture.runtime.release(101);
              fixture.request("clipboard-read");
              fixture.runtime.dispose();
              assert.deepEqual(fixture.results, [false, false, false]);
              assert.isEmpty(fixture.prompts());
              assert.isUndefined(store.get(origin, "notifications"));
            }),
          ),
      );

      it.effect(
        "reflects persisted decisions for page and worker checks without conflating media kinds",
        () =>
          withStore((store) =>
            Effect.gen(function* () {
              yield* store.set(origin, ["camera", "notifications"], "allow");
              yield* store.set(origin, ["microphone"], "block");
              const fixture = makeFixture(store);
              assert.isTrue(fixture.check("media", "video"));
              assert.isFalse(fixture.check("media", "audio"));
              assert.isFalse(fixture.check("media", "unknown"));
              assert.isTrue(
                fixture.runtime.check(null, "notifications", origin, { isMainFrame: false }),
              );
              assert.isFalse(
                fixture.runtime.check(null, "notifications", "https://other.example", {
                  isMainFrame: false,
                }),
              );
              fixture.request("media", { mediaTypes: ["video", "audio"] });
              assert.deepEqual(fixture.results, [false]);
              assert.isEmpty(fixture.prompts());
            }),
          ),
      );

      it.effect("reports real site permission state and resets one or all decisions", () =>
        withStore((store) =>
          Effect.gen(function* () {
            const fixture = makeFixture(store);
            const site = makeBrowserSiteInfoRuntime(
              { getTabSnapshot: () => ({ url: `${origin}/page`, webContentsId: 101 }) },
              { get: async () => [] },
              fixture.runtime,
            );
            yield* store.set(origin, ["camera"], "allow");
            yield* store.set(origin, ["notifications"], "block");
            const state = (yield* site.get(identity)).permissions;
            assert.deepInclude(state, { permission: "camera", state: "allow" });
            assert.deepInclude(state, { permission: "notifications", state: "block" });
            assert.deepInclude(state, { permission: "geolocation", state: "ask" });
            assert.deepInclude(state, { permission: "display-capture", state: "block" });
            yield* fixture.runtime.reset(origin, "camera");
            assert.deepInclude((yield* site.get(identity)).permissions, {
              permission: "camera",
              state: "ask",
            });
            assert.strictEqual(store.get(origin, "notifications"), "block");
            fixture.request("geolocation");
            yield* fixture.runtime.respond(fixture.response("allow-this-time"), 7);
            yield* fixture.runtime.reset(origin);
            assert.deepInclude((yield* site.get(identity)).permissions, {
              permission: "geolocation",
              state: "ask",
            });
            assert.deepInclude((yield* site.get(identity)).permissions, {
              permission: "notifications",
              state: "ask",
            });
          }),
        ),
      );

      it.effect(
        "offers OS settings when system access is blocked and validates available actions and accuracy",
        () =>
          withStore((store) =>
            Effect.gen(function* () {
              const fixture = makeFixture(store);
              fixture.osDenied.add("camera");
              fixture.request("media", { mediaTypes: ["video"] });
              const response = fixture.response("allow");
              assert.strictEqual(fixture.prompt().variant, "os-system-settings");
              assert.deepEqual(fixture.prompt().actions, ["dismiss"]);
              assert.isFalse((yield* fixture.runtime.respond(response, 7)).ok);
              const settings = {
                ...identity,
                type: "open-permission-system-settings" as const,
                promptId: response.promptId,
                mountGeneration: 2,
              };
              assert.isFalse((yield* fixture.runtime.openSystemSettings(settings, 8)).ok);
              assert.isTrue((yield* fixture.runtime.openSystemSettings(settings, 7)).ok);
              assert.deepEqual(fixture.opened, ["camera"]);
              yield* fixture.runtime.respond({ ...response, action: "dismiss" }, 7);
              fixture.request("geolocation");
              assert.isFalse(
                (yield* fixture.runtime.respond(
                  { ...fixture.response("allow"), geolocationAccuracy: "approximate" },
                  7,
                )).ok,
              );
              assert.isFalse(
                (yield* fixture.runtime.openSystemSettings(
                  { ...settings, promptId: fixture.prompt().id },
                  7,
                )).ok,
              );
              fixture.runtime.dispose();
            }),
          ),
      );

      it.effect("serializes concurrent decisions and quarantines invalid durable input", () =>
        withStore((store, filePath) =>
          Effect.gen(function* () {
            yield* Effect.all(
              [store.set(origin, ["camera"], "allow"), store.set(origin, ["microphone"], "block")],
              { concurrency: "unbounded" },
            );
            const reloaded = yield* makeBrowserPermissionStore(filePath);
            assert.strictEqual(reloaded.get(origin, "camera"), "allow");
            assert.strictEqual(reloaded.get(origin, "microphone"), "block");
            fs.writeFileSync(
              filePath,
              JSON.stringify({
                schemaVersion: 1,
                decisions: [
                  { origin: "https://example.com/path", permission: "camera", state: "allow" },
                ],
              }),
            );
            const empty = yield* makeBrowserPermissionStore(filePath);
            assert.isUndefined(empty.get(origin, "camera"));
            assert.isTrue(
              fs
                .readdirSync(path.dirname(filePath))
                .some((name) => name.startsWith("browser-permissions.json.corrupt-")),
            );
          }),
        ),
      );
    });
  });

  describe("browser-session-request-policy", () => {
    const restricted = {
      enabled: true,
      domains: { "allowed.example": "allow", "denied.example": "deny" },
    } as const;

    describe("Browser application network policy", () => {
      test.each([
        "http://localhost:3000/",
        "file:///tmp/index.html",
        "data:text/html,Hello",
        "blob:https://example.com/id",
        "about:blank",
        "chrome://flags",
        "https://user:secret@example.com/",
      ])("leaves unmanaged requests unrestricted: %s", (url) => {
        expect(allowsBrowserSessionRequest({ url, network: null })).toBe(true);
      });
      test.each([
        "app://-/index.html",
        "nodex://assets/file.png",
        "nodex-page-file://capability/index.html",
        "nodex-mcp-sandbox://frame/index.html",
        "file:///tmp/",
        "about:srcdoc",
        "data:text/html,Hello",
        "blob:https://example.com/id",
        "http://localhost:5173/vite",
        "ws://localhost:5173/socket",
        "https://allowed.example/path",
        "wss://allowed.example./socket",
      ])("admits internal, exact development and managed domains: %s", (url) => {
        expect(
          allowsBrowserSessionRequest({
            url,
            network: restricted,
            developmentOrigin: "http://localhost:5173/app",
          }),
        ).toBe(true);
      });
      test.each([
        "http://allowed.example/",
        "ws://allowed.example/socket",
        "https://child.allowed.example/",
        "https://denied.example/",
        "http://localhost:3000/",
        "http://localhost:5174/",
        "chrome://flags",
        "invalid",
      ])("applies managed network restrictions: %s", (url) => {
        expect(
          allowsBrowserSessionRequest({
            url,
            network: restricted,
            developmentOrigin: "http://localhost:5173/app",
          }),
        ).toBe(false);
      });
    });
  });
});

describe("browser-runtime-registry", () => {
  const identity = {
    browserConversationId: "conversation-1",
    browserViewScopeId: "window-session-1",
    browserTabId: "browser-tab-1",
  } as const;

  function host(overrides: Record<string, unknown> = {}) {
    return {
      ...identity,
      browserStorageId: "browser-storage-1",
      hostGeneration: 1,
      hostKind: "panel" as const,
      mountGeneration: 1,
      pagePersistence: "durable" as const,
      rendererInstanceId: "renderer-1",
      ...overrides,
    };
  }

  describe("BrowserRuntimeRegistry", () => {
    test("binds renderer and host generations to one owner window", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      expect(registry.registerHost(7, host()).ok).toBe(true);
      expect(
        registry.registerHost(
          8,
          host({
            hostGeneration: 2,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "renderer-session-mismatch",
      });
      expect(
        registry.registerHost(
          7,
          host({
            hostGeneration: 0,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "generation-stale",
      });
    });

    test("prevents one durable storage identity from being owned by two routes", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      expect(registry.registerHost(7, host()).ok).toBe(true);
      expect(
        registry.registerHost(
          7,
          host({
            browserTabId: "browser-tab-2",
            hostGeneration: 2,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "owned-by-another-window",
      });
    });

    test("uses a single-use attach token instead of attachment order", () => {
      let tokenSequence = 0;
      const registry = makeBrowserRuntimeRegistry({
        tokenFactory: () => `attach-${++tokenSequence}`,
      });
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      registry.registerHost(7, host());
      const authorization = registry.authorizeAttachment(7, host());
      expect(authorization.ok).toBe(true);
      if (!authorization.ok) throw new Error("Expected authorization");

      expect(
        registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 101),
      ).toMatchObject({
        ...identity,
        browserStorageId: "browser-storage-1",
        guestWebContentsId: 101,
        ownerWebContentsId: 7,
      });
      expect(
        registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 102),
      ).toBeNull();
    });

    test("rejects presentation updates from a superseded host generation", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      registry.registerHost(
        7,
        host({
          hostGeneration: 2,
          mountGeneration: 3,
        }),
      );

      expect(
        registry.matchHost(
          7,
          host({
            hostGeneration: 1,
            mountGeneration: 2,
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "host-mismatch",
      });
      expect(
        registry.matchHost(
          7,
          host({
            hostGeneration: 2,
            mountGeneration: 3,
          }),
        ),
      ).toMatchObject({
        ok: true,
        registration: {
          hostGeneration: 2,
          mountGeneration: 3,
        },
      });
    });

    test("authorizes a physical guest independently from the current presentation generation", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      registry.registerHost(7, host({ mountGeneration: 3 }));

      expect(
        registry.authorizeAttachment(7, {
          ...identity,
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
        }),
      ).toMatchObject({
        ok: true,
        authorization: {
          mountGeneration: 3,
        },
      });
    });

    test("revoked attachment authorization cannot be consumed", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      registry.registerHost(7, host());
      const authorization = registry.authorizeAttachment(7, host());
      expect(authorization.ok).toBe(true);
      if (!authorization.ok) throw new Error("Expected authorization");

      registry.revokeAuthorizedAttachment(authorization.authorization.attachToken);

      expect(
        registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 101),
      ).toBeNull();
    });

    test("blocks new attachments while generation-safe teardown is pending", () => {
      const registry = makeBrowserRuntimeRegistry();
      registry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      registry.registerHost(7, host());
      registry.markPendingTeardown(identity, true);

      expect(registry.authorizeAttachment(7, host())).toEqual({
        ok: false,
        reason: "pending-teardown",
      });
      registry.releaseOwner(7);
      expect(registry.getDiagnosticSnapshot()).toEqual({
        guests: 0,
        hosts: 0,
        pendingAttachments: 0,
        rendererSessions: 0,
      });
    });
  });
});

describe("browser-webview-attachment-policy", () => {
  const route: BrowserSidebarHostRouteIdentity = {
    browserConversationId: "conversation-1",
    browserViewScopeId: "window-session-1",
    browserTabId: "browser-tab-1",
    rendererInstanceId: "renderer-1",
    hostGeneration: 2,
    mountGeneration: 3,
  };
  const physicalRoute = {
    browserConversationId: route.browserConversationId,
    browserViewScopeId: route.browserViewScopeId,
    browserTabId: route.browserTabId,
    rendererInstanceId: route.rendererInstanceId,
    hostGeneration: route.hostGeneration,
  };

  const authorization: BrowserAuthorizedAttachment = {
    ...route,
    attachToken: "attach-1",
    browserStorageId: "browser-storage-1",
    ownerWebContentsId: 7,
  };

  function decide(overrides: Partial<Parameters<typeof decideBrowserWebviewAttachment>[0]> = {}) {
    return decideBrowserWebviewAttachment({
      authorizeAttachment: () => ({ ok: true, authorization }),
      isRegisteredBrowserStorage: () => true,
      ownerBrowserViewScopeId: route.browserViewScopeId,
      partition: makeBrowserSidebarRoutePartition(route, route),
      revokeAuthorizedAttachment: () => undefined,
      src: "https://www.google.com/",
      ...overrides,
    });
  }

  describe("Browser webview attachment policy", () => {
    test("authorizes from the registered host without custom webview parameters", () => {
      const authorizeAttachment = vi.fn(() => ({
        ok: true as const,
        authorization,
      }));

      expect(decide({ authorizeAttachment })).toEqual({
        ok: true,
        authorization,
      });
      expect(authorizeAttachment).toHaveBeenCalledWith(physicalRoute);
    });

    test("rejects foreign windows but leaves URL loading to the Browser guest", () => {
      const authorizeAttachment = vi.fn(() => ({
        ok: true as const,
        authorization,
      }));

      expect(
        decide({
          authorizeAttachment,
          ownerBrowserViewScopeId: "window-session-2",
        }),
      ).toMatchObject({
        ok: false,
        reason: "window-session-mismatch",
      });
      expect(
        decide({
          authorizeAttachment,
          src: "javascript:alert(1)",
        }),
      ).toMatchObject({
        ok: true,
        authorization,
      });
      expect(authorizeAttachment).toHaveBeenCalledTimes(1);
    });

    test("uses the Main-owned storage identity returned by host authorization", () => {
      const isRegisteredBrowserStorage = vi.fn(() => false);
      const revokeAuthorizedAttachment = vi.fn();

      expect(
        decide({
          isRegisteredBrowserStorage,
          revokeAuthorizedAttachment,
        }),
      ).toMatchObject({
        ok: false,
        reason: "storage-identity-mismatch",
      });
      expect(isRegisteredBrowserStorage).toHaveBeenCalledWith(
        physicalRoute,
        authorization.browserStorageId,
      );
      expect(revokeAuthorizedAttachment).toHaveBeenCalledWith(authorization.attachToken);
    });

    test("preserves the exact registry rejection reason", () => {
      expect(
        decide({
          authorizeAttachment: () => ({
            ok: false,
            reason: "host-mismatch",
          }),
        }),
      ).toMatchObject({
        ok: false,
        reason: "authorization-host-mismatch",
      });
    });

    test("correlates will-attach instanceId with did-attach viewInstanceId", () => {
      const pending = new Map<number, BrowserAuthorizedAttachment>();
      const secondAuthorization = {
        ...authorization,
        attachToken: "attach-2",
      };

      expect(registerPendingBrowserWebviewAttachment(pending, "41", authorization)).toEqual({
        ok: true,
        instanceId: 41,
      });
      expect(registerPendingBrowserWebviewAttachment(pending, 42, secondAuthorization)).toEqual({
        ok: true,
        instanceId: 42,
      });
      expect(consumePendingBrowserWebviewAttachment(pending, 42)).toBe(secondAuthorization);
      expect(consumePendingBrowserWebviewAttachment(pending, 41)).toBe(authorization);
      expect(consumePendingBrowserWebviewAttachment(pending, 41)).toBeNull();
    });

    test("rejects invalid or duplicate Electron instance ids without overwriting", () => {
      const pending = new Map<number, BrowserAuthorizedAttachment>();

      expect(registerPendingBrowserWebviewAttachment(pending, 0, authorization)).toEqual({
        ok: false,
        reason: "invalid-instance-id",
      });
      expect(registerPendingBrowserWebviewAttachment(pending, 7, authorization)).toEqual({
        ok: true,
        instanceId: 7,
      });
      expect(
        registerPendingBrowserWebviewAttachment(pending, 7, {
          ...authorization,
          attachToken: "replacement",
        }),
      ).toEqual({ ok: false, reason: "duplicate-instance-id" });
      expect(consumePendingBrowserWebviewAttachment(pending, 7)).toBe(authorization);
    });
  });

  test("a Browser page guest keeps popup requests and loses every renderer claim", () => {
    const preferences: Record<string, unknown> = {
      disablePopups: true,
      nodeIntegration: true,
      preloadURL: "file:///renderer-preload.js",
      sandbox: false,
      webSecurity: false,
    };
    const params = {
      partition: "persist:renderer-claim",
      allowpopups: "",
      disablewebsecurity: "",
      nodeintegration: "",
      preload: "file:///renderer-preload.js",
      webpreferences: "contextIsolation=no",
      src: "https://example.com/",
    };
    forceBrowserPageGuestPreferences(preferences, params, {
      partition: "persist:browser",
      preload: "/app/browser-guest.js",
    });

    // Chromium drops window-open requests before the Browser's handler when this is true.
    expect(preferences.disablePopups).toBe(false);
    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:browser",
      preload: "/app/browser-guest.js",
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
    expect(preferences).not.toHaveProperty("preloadURL");
    expect(params).toEqual({ partition: "persist:browser", src: "https://example.com/" });
  });
});

describe("browser-event-routing", () => {
  const makeTab = (
    browserViewScopeId: string,
    browserTabId: string,
  ): BrowserSidebarTabSnapshot => ({
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId,
    projectId: "project-1",
    webContentsId: null,
    mountGeneration: 0,
    url: "about:blank",
    title: "New tab",
    isLoading: false,
    isWaitingForResponse: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    deviceToolbarVisible: false,
    viewport: {
      width: 390,
      height: 844,
      zoomPercent: 100,
      presetId: "responsive",
    },
    deviceToolbarState: {
      responsiveViewportSize: null,
      toolbarState: {
        isEnabled: false,
        presetId: "responsive",
        width: 390,
        height: 844,
      },
    },
    interactionMode: "browse",
    findState: {
      open: false,
      query: "",
      activeMatchOrdinal: null,
      matchCount: null,
      caseSensitive: false,
    },
    hasBrowserPage: false,
    pageActionsDisabled: true,
    updatedAt: 1,
  });

  const makeBrowserUseTab = (
    browserViewScopeId: string,
    browserTabId: string,
  ): BrowserUseTabState => ({
    browserConversationId: "session-1",
    browserViewScopeId,
    browserTabId,
    codexSessionId: "thread-1",
    projectId: "project-1",
    title: "Tab",
    url: "https://example.com/",
    webContentsId: null,
    viewport: {
      width: 390,
      height: 844,
      zoomPercent: 100,
      presetId: "responsive",
    },
    captureActive: false,
    released: false,
    updatedAt: 1,
  });

  describe("Browser event routing", () => {
    test("filters ordinary Browser state by Window Session scope", () => {
      const snapshot: BrowserSidebarStateSnapshot = {
        tabs: [
          makeTab("window-session-1", "shared-tab"),
          makeTab("window-session-2", "shared-tab"),
        ],
      };

      expect(filterBrowserStateForViewScope(snapshot, "window-session-2").tabs).toEqual([
        expect.objectContaining({
          browserViewScopeId: "window-session-2",
        }),
      ]);
    });

    test("filters Browser Use tabs, cursors, and active ids together", () => {
      const snapshot: BrowserSidebarBrowserUseStateSnapshot = {
        tabs: [
          makeBrowserUseTab("window-session-1", "shared-tab"),
          makeBrowserUseTab("window-session-2", "shared-tab"),
        ],
        cursors: [
          {
            browserConversationId: "session-1",
            browserViewScopeId: "window-session-1",
            browserTabId: "shared-tab",
            moveSequence: 1,
            x: 1,
            y: 2,
            visible: true,
            updatedAt: 1,
          },
          {
            browserConversationId: "session-1",
            browserViewScopeId: "window-session-2",
            browserTabId: "shared-tab",
            moveSequence: 2,
            x: 3,
            y: 4,
            visible: true,
            updatedAt: 1,
          },
        ],
        activeBrowserTabIdsByConversationScope: {
          "session-1\0window-session-1": "shared-tab",
          "session-1\0window-session-2": "shared-tab",
        },
      };

      expect(filterBrowserUseStateForViewScope(snapshot, "window-session-2")).toEqual({
        tabs: [
          expect.objectContaining({
            browserViewScopeId: "window-session-2",
          }),
        ],
        cursors: [
          expect.objectContaining({
            browserViewScopeId: "window-session-2",
            x: 3,
          }),
        ],
        activeBrowserTabIdsByConversationScope: {
          "session-1\0window-session-2": "shared-tab",
        },
      });
    });
  });
});

describe("browser-page-emulation", () => {
  function target({ initiallyAttached = false } = {}) {
    const commands: Array<[string, Record<string, unknown> | undefined]> = [];
    let attached = initiallyAttached;
    return {
      commands,
      target: {
        debugger: {
          attach: vi.fn((_protocolVersion?: string) => {
            attached = true;
          }),
          detach: vi.fn(() => {
            attached = false;
          }),
          isAttached: () => attached,
          sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
            commands.push([method, params]);
          }),
        },
        isDestroyed: () => false,
      },
    };
  }

  describe("Browser page emulation runtime", () => {
    it.effect("retains one debugger session and detaches it when its Scope closes", () =>
      Effect.gen(function* () {
        const fixture = target();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeBrowserPageEmulationRuntime;
            const result = yield* runtime.syncDeviceMetrics(fixture.target, {
              width: 393,
              height: 852,
              zoomPercent: 100,
              presetId: "iphone-15-pro",
            });
            assert.deepEqual(result, { ok: true });
            assert.isTrue(runtime.isDebuggerRetained(fixture.target));
          }),
        );

        assert.strictEqual(fixture.target.debugger.attach.mock.calls[0]?.[0], "1.3");
        assert.strictEqual(fixture.target.debugger.detach.mock.calls.length, 1);
        assert.deepEqual(
          fixture.commands.map(([method]) => method),
          ["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled"],
        );
      }),
    );

    it.effect("serializes mutations for one guest", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = target({ initiallyAttached: true });
          let releaseFirstCommand: () => void = () => undefined;
          let markFirstCommandStarted: () => void = () => undefined;
          const firstCommandStarted = new Promise<void>((resolve) => {
            markFirstCommandStarted = resolve;
          });
          fixture.target.debugger.sendCommand.mockImplementationOnce(
            async (method: string, params?: Record<string, unknown>) => {
              fixture.commands.push([method, params]);
              markFirstCommandStarted();
              await new Promise<void>((resolve) => {
                releaseFirstCommand = resolve;
              });
            },
          );
          const runtime = yield* makeBrowserPageEmulationRuntime;
          const colorScheme = yield* Effect.forkChild(
            runtime.syncColorScheme(fixture.target, "light"),
          );
          const metrics = yield* Effect.forkChild(runtime.clearDeviceMetrics(fixture.target));
          yield* Effect.promise(() => firstCommandStarted);
          assert.deepEqual(
            fixture.commands.map(([method]) => method),
            ["Emulation.setEmulatedMedia"],
          );

          releaseFirstCommand();
          assert.deepEqual(yield* Effect.all([Fiber.join(colorScheme), Fiber.join(metrics)]), [
            { ok: true },
            { ok: true },
          ]);
          assert.deepEqual(
            fixture.commands.map(([method]) => method),
            [
              "Emulation.setEmulatedMedia",
              "Emulation.clearDeviceMetricsOverride",
              "Emulation.setTouchEmulationEnabled",
            ],
          );
        }),
      ),
    );

    it.effect("closes admission, drains the guest lane, and detaches on release", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = target();
          let finishCommand: () => void = () => undefined;
          let markCommandStarted: () => void = () => undefined;
          const commandStarted = new Promise<void>((resolve) => {
            markCommandStarted = resolve;
          });
          fixture.target.debugger.sendCommand.mockImplementationOnce(async () => {
            markCommandStarted();
            await new Promise<void>((resolve) => {
              finishCommand = resolve;
            });
          });
          const runtime = yield* makeBrowserPageEmulationRuntime;
          const command = yield* Effect.forkChild(runtime.syncColorScheme(fixture.target, "dark"));
          yield* Effect.promise(() => commandStarted);
          const release = yield* Effect.forkChild(runtime.release(fixture.target));
          yield* Effect.yieldNow;
          assert.strictEqual(fixture.target.debugger.detach.mock.calls.length, 0);
          assert.isTrue(runtime.isDebuggerRetained(fixture.target));
          assert.deepEqual(yield* runtime.retainDebugger(fixture.target), {
            ok: false,
            reason: "target-destroyed",
          });

          finishCommand();
          assert.deepEqual(yield* Fiber.join(command), { ok: true });
          yield* Fiber.join(release);
          assert.strictEqual(fixture.target.debugger.detach.mock.calls.length, 1);
          assert.isFalse(runtime.isDebuggerRetained(fixture.target));
          assert.deepEqual(yield* runtime.retainDebugger(fixture.target), {
            ok: false,
            reason: "target-destroyed",
          });
        }),
      ),
    );
  });
});
