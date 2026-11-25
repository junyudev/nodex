import { describe, vi, expect, test } from "vite-plus/test";
import {
  WebContentsDestructionSubscriptions,
  makeWebContentsDestructionSubscriptions,
} from "../platform/electron/WebContentsDestructionSubscriptions";
import { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { NativeImage, Session, WebContents, WebPreferences } from "electron";
import {
  appendMcpAppSandboxInitId,
  buildMcpAppSandboxPartition,
  buildMcpAppSandboxSourceUrl,
  deriveMcpAppSandboxIdentity,
  MCP_APP_SANDBOX_SCHEME,
} from "../../shared/mcp-app/mcp-app-sandbox-contract";
import type { BackendLogger } from "../logging/logger";
import {
  makeMcpAppSandboxController as makeBase,
  type McpAppSandboxPlatform,
} from "./mcp-app-sandbox-host";
import { makeMcpAppSandboxProtocolCache } from "./mcp-app-sandbox-protocol";
import { decideMcpAppWebviewAttachment } from "./mcp-app-webview-attachment-policy";

describe("mcp-app-sandbox-host", () => {
  function makeSession() {
    const events = new EventEmitter();
    const state = {
      beforeRequest: undefined as unknown,
      beforeSendHeaders: undefined as unknown,
      handledScheme: null as string | null,
      permissionCheck: undefined as unknown,
      permissionRequest: undefined as unknown,
      unhandledSchemes: [] as string[],
      cleared: [] as string[],
      failClearData: false,
    };
    const value = {
      clearData: async () => {
        state.cleared.push("data");
        if (state.failClearData) throw new Error("Clear failed");
      },
      clearCodeCaches: async () => {
        state.cleared.push("code");
      },
      clearAuthCache: async () => {
        state.cleared.push("auth");
      },
      getUserAgent: () => "Mozilla/5.0 Electron/40.0 Nodex/1.0 Chrome/140.0.0.0",
      on: events.on.bind(events),
      protocol: {
        handle: (scheme: string) => {
          state.handledScheme = scheme;
        },
        unhandle: async (scheme: string) => {
          state.unhandledSchemes.push(scheme);
        },
      },
      removeListener: events.removeListener.bind(events),
      setPermissionCheckHandler: (handler: unknown) => {
        state.permissionCheck = handler;
      },
      setPermissionRequestHandler: (handler: unknown) => {
        state.permissionRequest = handler;
      },
      webRequest: {
        onBeforeRequest: (handler: unknown) => {
          state.beforeRequest = handler;
        },
        onBeforeSendHeaders: (handler: unknown) => {
          state.beforeSendHeaders = handler;
        },
      },
    } as unknown as Session;
    return { events, state, value };
  }

  it.effect(
    "inline HTML navigation preserves focus without changing ordinary MCP preferences",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sandboxSession = makeSession();
          const owner = Object.assign(new EventEmitter(), {
            id: 91,
            isDestroyed: () => false,
          }) as unknown as WebContents;
          const controller = yield* makeMcpAppSandboxController(
            {
              allowLocalDevelopment: false,
              applicationName: "Nodex",
              guestPreloadPath: "/tmp/mcp-app-preload.js",
              locale: "en-US",
              logger: { error: () => undefined, warn: () => undefined } as unknown as BackendLogger,
              platform: "darwin",
              preferredSystemLanguages: ["en-US"],
            },
            {
              createHandler: () => async () => new Response("ok"),
              getState: () => "cold",
              prewarm: async () => undefined,
            },
            { schedule: () => () => undefined },
            {
              defaultSession: makeSession().value,
              fromPartition: () => sandboxSession.value,
              onGuestMessage: () => () => undefined,
              showGuestContextMenu: () => undefined,
            },
          );
          const inline = yield* Effect.promise(() =>
            deriveMcpAppSandboxIdentity({
              locale: "en-US",
              originScope: { kind: "inline_visualization", scopeId: "standby-focus" },
              widgetDomain: null,
            }),
          );
          const ordinary = yield* Effect.promise(() =>
            deriveMcpAppSandboxIdentity({
              locale: "en-US",
              originScope: { kind: "mcp_server", server: "calendar" },
              widgetDomain: null,
            }),
          );
          const host = controller.createHost(owner);
          const cases = [
            { identity: inline, focus: true, expected: false },
            { identity: ordinary, focus: undefined, expected: undefined },
            { identity: ordinary, focus: true, expected: true },
            {
              identity: {
                ...ordinary,
                sourceUrl: buildMcpAppSandboxSourceUrl({
                  locale: "en-US",
                  subdomain: "codex-inline-visualization-0123456789abcdef-extra",
                }),
              },
              focus: true,
              expected: true,
            },
          ];
          for (const [index, entry] of cases.entries()) {
            const preferences: WebPreferences = {
              nodeIntegration: true,
              sandbox: false,
              webSecurity: false,
              ...(entry.focus === undefined ? {} : { focusOnNavigation: entry.focus }),
            };
            const params = {
              partition: entry.identity.partition,
              src: appendMcpAppSandboxInitId(entry.identity.sourceUrl, `focus-init-${index}`),
              webpreferences: "focusOnNavigation=true,sandbox=false",
            };
            let prevented = false;
            host.handleWillAttach(
              {
                preventDefault: () => {
                  prevented = true;
                },
              } as unknown as Electron.Event,
              preferences,
              params,
            );
            assert.isFalse(prevented);
            assert.strictEqual(preferences.focusOnNavigation, entry.expected);
            assert.isFalse(preferences.nodeIntegration);
            assert.isTrue(preferences.sandbox);
            assert.isTrue(preferences.webSecurity);
            assert.isUndefined(params.webpreferences);
          }
        }),
      ),
  );

  it.effect("owns the complete MCP App sandbox callback graph with its Scope", () =>
    Effect.gen(function* () {
      const defaultSession = makeSession();
      const sandboxSession = makeSession();
      const ownerEvents = new EventEmitter();
      const owner = Object.assign(ownerEvents, {
        id: 71,
        isDestroyed: () => false,
        postMessage: () => undefined,
      }) as unknown as WebContents;
      let guestMessageReleases = 0;
      let expirationCancels = 0;
      const platform: McpAppSandboxPlatform = {
        defaultSession: defaultSession.value,
        fromPartition: () => sandboxSession.value,
        onGuestMessage: () => () => {
          guestMessageReleases += 1;
        },
        showGuestContextMenu: () => undefined,
      };
      const scope = yield* Scope.make();
      const controller = yield* makeMcpAppSandboxController(
        {
          allowLocalDevelopment: false,
          applicationName: "Nodex",
          guestPreloadPath: "/tmp/mcp-app-preload.js",
          locale: "en-US",
          logger: {
            error: () => undefined,
            warn: () => undefined,
          } as unknown as BackendLogger,
          platform: "darwin",
          preferredSystemLanguages: ["zh-CN", "en-US"],
        },
        {
          createHandler: () => async () => new Response("ok"),
          getState: () => "cold",
          prewarm: async () => undefined,
        },
        {
          schedule: () => () => {
            expirationCancels += 1;
          },
        },
        platform,
      ).pipe(Effect.provideService(Scope.Scope, scope));

      const host = controller.createHost(owner);
      assert.strictEqual(ownerEvents.listenerCount("destroyed"), 1);
      const sandboxId = "source-0123456789abcdef";
      const partition = buildMcpAppSandboxPartition(sandboxId);
      const source = appendMcpAppSandboxInitId(
        buildMcpAppSandboxSourceUrl({ locale: "zh-CN", subdomain: "mcp-calendar-fixture" }),
        "init-fixture",
      );
      let rewrittenHeaders: Record<string, string> | undefined;
      const rewriteDefaultHeaders = defaultSession.state.beforeSendHeaders as (
        details: {
          readonly frame: { readonly origin: string };
          readonly requestHeaders: Record<string, string>;
          readonly url: string;
        },
        callback: (result: { readonly requestHeaders: Record<string, string> }) => void,
      ) => void;
      rewriteDefaultHeaders(
        { frame: { origin: source }, requestHeaders: {}, url: "https://example.test/data" },
        (result) => {
          rewrittenHeaders = result.requestHeaders;
        },
      );
      assert.strictEqual(rewrittenHeaders?.["User-Agent"], "Mozilla/5.0 Chrome/140.0.0.0");
      assert.strictEqual(rewrittenHeaders?.["Accept-Language"], "zh-CN,en-US;q=0.9");
      assert.strictEqual(rewrittenHeaders?.["sec-ch-ua-platform"], '"macOS"');
      let prevented = false;
      host.handleWillAttach(
        {
          preventDefault: () => {
            prevented = true;
          },
        } as unknown as Electron.Event,
        {} as WebPreferences,
        { partition, src: source },
      );

      assert.isFalse(prevented);
      assert.strictEqual(sandboxSession.state.handledScheme, MCP_APP_SANDBOX_SCHEME);
      assert.isFunction(sandboxSession.state.permissionCheck);
      assert.isFunction(sandboxSession.state.permissionRequest);
      assert.isFunction(sandboxSession.state.beforeRequest);
      assert.isFunction(sandboxSession.state.beforeSendHeaders);

      const guestEvents = new EventEmitter();
      let destroyed = false;
      const image = {} as NativeImage;
      const capturePage = vi.fn(async () => image);
      const focus = vi.fn(() => undefined);
      const guest = Object.assign(guestEvents, {
        id: 72,
        session: sandboxSession.value,
        getURL: () => source,
        isDestroyed: () => destroyed,
        setWindowOpenHandler: () => undefined,
        focus,
        capturePage,
        close: () => {
          destroyed = true;
          guestEvents.emit("destroyed");
        },
      }) as unknown as WebContents;
      assert.isTrue(host.handleDidAttach(guest));
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      guestEvents.emit("before-mouse-event", {}, { type: "mouseMove" });
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId));
      guestEvents.emit("before-mouse-event", {}, { type: "mouseDown" });
      assert.isFalse(
        controller.consumeUserGesture(
          { id: 999, isDestroyed: () => false } as WebContents,
          sandboxId,
        ),
      );
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "wrong-init"));
      assert.isTrue(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      guestEvents.emit(
        "before-input-event",
        {},
        { type: "keyDown", key: "Enter", isAutoRepeat: true },
      );
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId));
      guestEvents.emit(
        "before-input-event",
        {},
        { type: "keyDown", key: " ", isAutoRepeat: false },
      );
      assert.isTrue(controller.consumeUserGesture(owner, sandboxId));
      guestEvents.emit("before-mouse-event", {}, { type: "mouseDown" });
      const now = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5_001);
      try {
        assert.isFalse(controller.consumeUserGesture(owner, sandboxId));
      } finally {
        now.mockRestore();
      }

      assert.strictEqual(yield* controller.captureImage(owner, sandboxId, "init-fixture"), image);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(controller.captureImage(owner, sandboxId, "wrong-init"))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            controller.captureImage(
              { id: 999, isDestroyed: () => false } as WebContents,
              sandboxId,
              "init-fixture",
            ),
          ),
        ),
      );
      assert.strictEqual(capturePage.mock.calls.length, 1);
      guestEvents.emit("before-mouse-event", {}, { type: "mouseDown" });
      const focusedBeforePause = focus.mock.calls.length;
      assert.isFalse(
        controller.setGuestPresentation(
          { id: 999, isDestroyed: () => false } as WebContents,
          sandboxId,
          "init-fixture",
          false,
          1,
        ),
      );
      assert.isFalse(controller.setGuestPresentation(owner, sandboxId, "wrong-init", false, 1));
      assert.isFalse(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 0));
      assert.isFalse(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 1.5));
      assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 1));
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      guestEvents.emit("before-mouse-event", {}, { type: "mouseDown" });
      guestEvents.emit("before-input-event", {}, { type: "keyDown", key: "Enter" });
      assert.strictEqual(focus.mock.calls.length, focusedBeforePause);
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(controller.captureImage(owner, sandboxId, "init-fixture")),
        ),
      );
      assert.strictEqual(capturePage.mock.calls.length, 1);
      assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 1));
      assert.isFalse(controller.setGuestPresentation(owner, sandboxId, "init-fixture", true, 1));
      assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", true, 2));
      assert.isFalse(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 1));
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      guestEvents.emit("before-mouse-event", {}, { type: "mouseDown" });
      assert.isTrue(controller.consumeUserGesture(owner, sandboxId, "init-fixture"));
      const deferredCapture = controller.captureImage(owner, sandboxId, "init-fixture");
      assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 3));
      assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", true, 4));
      assert.strictEqual(
        yield* deferredCapture.pipe(
          Effect.catchTag("McpAppSandboxCaptureError", (error) => Effect.succeed(error.reason)),
        ),
        "unavailable",
      );
      assert.strictEqual(capturePage.mock.calls.length, 1);
      capturePage.mockImplementationOnce(async () => {
        assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", false, 5));
        assert.isTrue(controller.setGuestPresentation(owner, sandboxId, "init-fixture", true, 6));
        return image;
      });
      assert.strictEqual(
        yield* controller
          .captureImage(owner, sandboxId, "init-fixture")
          .pipe(
            Effect.catchTag("McpAppSandboxCaptureError", (error) => Effect.succeed(error.reason)),
          ),
        "retired",
      );
      assert.strictEqual(yield* controller.captureImage(owner, sandboxId, "init-fixture"), image);
      assert.isFalse(destroyed);
      assert.strictEqual(capturePage.mock.calls.length, 3);
      capturePage.mockImplementationOnce(async () => {
        assert.isFalse(controller.releaseGuest(owner, sandboxId, "wrong-init"));
        assert.isTrue(controller.releaseGuest(owner, sandboxId, "init-fixture"));
        return image;
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(controller.captureImage(owner, sandboxId, "init-fixture")),
        ),
      );
      assert.isFalse(controller.releaseGuest(owner, sandboxId, "init-fixture"));

      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(guestMessageReleases, 1);
      assert.strictEqual(expirationCancels, 1);
      assert.isNull(defaultSession.state.beforeSendHeaders);
      assert.isNull(sandboxSession.state.beforeRequest);
      assert.isNull(sandboxSession.state.beforeSendHeaders);
      assert.isNull(sandboxSession.state.permissionCheck);
      assert.isNull(sandboxSession.state.permissionRequest);
      assert.deepEqual(sandboxSession.state.unhandledSchemes, [MCP_APP_SANDBOX_SCHEME]);
      assert.strictEqual(ownerEvents.listenerCount("destroyed"), 0);
      assert.throws(() => controller.createHost(owner), /not installed/u);
      assert.isFalse(controller.consumeUserGesture(owner, sandboxId));
    }),
  );

  const appDataFixture = Effect.gen(function* () {
    const first = makeSession();
    const second = makeSession();
    const defaultSession = makeSession();
    const controller = yield* makeMcpAppSandboxController(
      {
        allowLocalDevelopment: false,
        applicationName: "Nodex",
        guestPreloadPath: "/preload.js",
        locale: "en-US",
        logger: { error: () => undefined, warn: () => undefined } as unknown as BackendLogger,
        platform: "darwin",
        preferredSystemLanguages: ["en-US"],
      },
      {
        createHandler: () => async () => new Response("ok"),
        getState: () => "cold",
        prewarm: async () => undefined,
      },
      { schedule: () => () => undefined },
      {
        defaultSession: defaultSession.value,
        fromPartition: (partition) =>
          partition.endsWith("1111111111111111") ? first.value : second.value,
        onGuestMessage: () => () => undefined,
        showGuestContextMenu: () => undefined,
      },
    );
    const owners = [1, 2].map((id) =>
      Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
    );
    for (const [index, owner] of owners.entries()) {
      const host = controller.createHost(owner as unknown as WebContents);
      const sandboxId = `source-${String(index + 1).repeat(16)}`;
      const attach = () =>
        host.handleWillAttach(
          {
            preventDefault: () => {
              throw new Error("Valid sandbox rejected");
            },
          } as unknown as Electron.Event,
          {},
          {
            partition: buildMcpAppSandboxPartition(sandboxId),
            src: appendMcpAppSandboxInitId(
              buildMcpAppSandboxSourceUrl({ subdomain: "app-data", locale: "en-US" }),
              `init-${index}`,
            ),
          },
        );
      attach();
      attach();
    }
    return { controller, first, second, defaultSession, owners };
  });

  it.effect(
    "clears every configured MCP session once, including closed views, and leaves the default session intact",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* appDataFixture;
          h.owners[0]!.emit("destroyed");
          assert.strictEqual(h.controller.appDataAvailable(), true);
          yield* h.controller.clearAppData;
          assert.deepEqual(h.first.state.cleared, ["data", "code", "auth"]);
          assert.deepEqual(h.second.state.cleared, ["data", "code", "auth"]);
          assert.deepEqual(h.defaultSession.state.cleared, []);
          yield* h.controller.clearAppData;
          assert.strictEqual(h.first.state.cleared.length, 6);
          assert.strictEqual(h.second.state.cleared.length, 6);
        }),
      ),
  );
  it.effect(
    "continues clearing remaining caches and sessions after a failure and returns a typed failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* appDataFixture;
          h.first.state.failClearData = true;
          assert.strictEqual((yield* h.controller.clearAppData.pipe(Effect.flip)).reason, "failed");
          assert.deepEqual(h.first.state.cleared, ["data", "code", "auth"]);
          assert.deepEqual(h.second.state.cleared, ["data", "code", "auth"]);
        }),
      ),
  );
  it.effect("makes clearing unavailable after the sandbox owner releases", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const h = yield* appDataFixture.pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(h.controller.appDataAvailable(), false);
      assert.strictEqual(
        (yield* h.controller.clearAppData.pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.deepEqual(h.first.state.cleared, []);
    }),
  );

  const makeMcpAppSandboxController = Effect.fnUntraced(function* (
    ...args: Parameters<typeof makeBase>
  ) {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    return yield* makeBase(...args).pipe(
      Effect.provideService(WebContentsDestructionSubscriptions, subscriptions),
    );
  });
});

describe("mcp-app-sandbox-protocol", () => {
  const makeCache = (fetch: Electron.Net["fetch"]) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const cache = yield* makeMcpAppSandboxProtocolCache(fetch).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { cache, scope };
    });

  const sourceUrl = (subdomain: string, locale: string) =>
    buildMcpAppSandboxSourceUrl({ subdomain, locale });

  it.effect("proxies only the audited Skybridge root and strips ambient headers", () =>
    Effect.gen(function* () {
      const requests: Array<[string, RequestInit]> = [];
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        requests.push([url, init]);
        return new Response("<main />", {
          headers: {
            "Content-Security-Policy": "default-src 'none'",
            "Content-Type": "text/html",
            "Set-Cookie": "session=secret",
            "X-Upstream-Internal": "secret",
          },
        });
      });
      const { cache, scope } = yield* makeCache(fetch as never);
      const response = yield* Effect.promise(() =>
        cache.createHandler()(new Request(sourceUrl("mcp-calendar-fixture", "zh-CN"))),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(fetch.mock.calls.length, 1);
      assert.include(requests[0]![0], "https://web-sandbox.oaiusercontent.com/");
      const init = requests[0]![1];
      assert.strictEqual(init.credentials, "omit");
      assert.strictEqual(init.redirect, "error");
      assert.instanceOf(init.signal, AbortSignal);
      assert.strictEqual(response.headers.get("content-security-policy"), "default-src 'none'");
      assert.isNull(response.headers.get("set-cookie"));
      assert.isNull(response.headers.get("x-upstream-internal"));
      assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("rejects foreign hosts, extra root parameters, and mutation methods", () =>
    Effect.gen(function* () {
      const { cache, scope } = yield* makeCache(vi.fn() as never);
      const handler = cache.createHandler();
      const source = sourceUrl("mcp-calendar-fixture", "zh-CN");
      const responses = yield* Effect.promise(() =>
        Promise.all([
          handler(new Request(source.replace("web-sandbox.oaiusercontent.com", "example.com"))),
          handler(new Request(source.replace("deviceType=desktop", "deviceType=desktop&extra=1"))),
          handler(new Request(source, { method: "POST" })),
        ]),
      );
      assert.deepEqual(
        responses.map((response) => response.status),
        [404, 404, 404],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("deduplicates in-flight and warm-cache requests", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async () =>
          new Response("cached-skybridge", {
            headers: { "Content-Type": "text/html" },
          }),
      );
      const { cache, scope } = yield* makeCache(fetch as never);
      const handler = cache.createHandler();
      const source = sourceUrl("mcp-cache-fixture", "en-cache");
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([handler(new Request(source)), handler(new Request(source))]),
      );

      assert.strictEqual(yield* Effect.promise(() => first.text()), "cached-skybridge");
      assert.strictEqual(yield* Effect.promise(() => second.text()), "cached-skybridge");
      assert.strictEqual(fetch.mock.calls.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("coalesces prewarm and marks the complete runtime asset graph warm", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async (url: string) => {
        if (url.includes("/assets/main-abcdefgh.js")) {
          return new Response('import "/assets/run-widget-code-abcdefgh.js"');
        }
        if (url.includes("/assets/run-widget-code-abcdefgh.js")) {
          return new Response("export const ready = true");
        }
        return new Response('<script src="/assets/main-abcdefgh.js"></script>');
      });
      const { cache, scope } = yield* makeCache(fetch as never);

      yield* Effect.promise(() => Promise.all([cache.prewarm("en-US"), cache.prewarm("en-US")]));

      assert.strictEqual(fetch.mock.calls.length, 3);
      assert.strictEqual(cache.getState(sourceUrl("mcp-prewarm-fixture", "en-US")), "warm");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("allows only fingerprinted Skybridge JavaScript and CSS assets", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async () => new Response("asset", { headers: { "Content-Type": "text/javascript" } }),
      );
      const { cache, scope } = yield* makeCache(fetch as never);
      const handler = cache.createHandler();
      const [allowed, denied] = yield* Effect.promise(() =>
        Promise.all([
          handler(
            new Request(
              "nodex-mcp-sandbox://fixture.web-sandbox.oaiusercontent.com/assets/main-abcdefgh.js",
            ),
          ),
          handler(
            new Request(
              "nodex-mcp-sandbox://fixture.web-sandbox.oaiusercontent.com/assets/main.js",
            ),
          ),
        ]),
      );
      assert.strictEqual(allowed.status, 200);
      assert.strictEqual(denied.status, 404);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("isolates caches by coordinator lifetime", () =>
    Effect.gen(function* () {
      const firstFetch = vi.fn(async () => new Response("first"));
      const secondFetch = vi.fn(async () => new Response("second"));
      const first = yield* makeCache(firstFetch as never);
      const second = yield* makeCache(secondFetch as never);
      const source = sourceUrl("mcp-scope-fixture", "en-scope");

      const [firstResponse, secondResponse] = yield* Effect.promise(() =>
        Promise.all([
          first.cache
            .createHandler()(new Request(source))
            .then((response) => response.text()),
          second.cache
            .createHandler()(new Request(source))
            .then((response) => response.text()),
        ]),
      );
      assert.strictEqual(firstResponse, "first");
      assert.strictEqual(secondResponse, "second");
      assert.strictEqual(firstFetch.mock.calls.length, 1);
      assert.strictEqual(secondFetch.mock.calls.length, 1);
      yield* Scope.close(first.scope, Exit.void);
      yield* Scope.close(second.scope, Exit.void);
    }),
  );

  it.effect("aborts in-flight fetches and rejects later admission when released", () =>
    Effect.gen(function* () {
      const fetch = vi.fn(
        async (_url: string, init: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const { cache, scope } = yield* makeCache(fetch as never);
      const handler = cache.createHandler();
      const source = sourceUrl("mcp-dispose-fixture", "en-dispose");
      const pending = handler(new Request(source));

      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual((yield* Effect.promise(() => pending)).status, 404);
      assert.strictEqual((yield* Effect.promise(() => handler(new Request(source)))).status, 404);
      assert.strictEqual(cache.getState(source), "cold");
    }),
  );
});

describe("mcp-app-webview-attachment-policy", () => {
  const sandboxId = "source-0123456789abcdef";
  const partition = buildMcpAppSandboxPartition(sandboxId);
  const baseSource = buildMcpAppSandboxSourceUrl({
    subdomain: "mcp-calendar-fixture",
    locale: "zh-CN",
  });
  const src = appendMcpAppSandboxInitId(baseSource, "init-fixture");

  describe("MCP App webview attachment policy", () => {
    test("binds the isolated session to a validated sandbox source", () => {
      expect(
        decideMcpAppWebviewAttachment({
          partition,
          src,
        }),
      ).toMatchObject({
        ok: true,
        sandboxId,
        initId: "init-fixture",
      });
    });

    test.each([
      ["invalid partition", "persist:source-fixture", src],
      ["invalid source", partition, "https://example.com"],
      [
        "source with extra query capability",
        partition,
        baseSource.replace("deviceType=desktop", "deviceType=desktop&extra=1") +
          "#initId=init-fixture",
      ],
    ])("rejects %s", (_label, candidatePartition, candidateSource) => {
      expect(
        decideMcpAppWebviewAttachment({
          partition: candidatePartition,
          src: candidateSource,
        }).ok,
      ).toBe(false);
    });

    test("requires the renderer handshake init id in the source hash", () => {
      expect(
        decideMcpAppWebviewAttachment({
          partition,
          src: baseSource,
        }),
      ).toEqual({ ok: false, reason: "invalid-init-id" });
    });
  });
});
