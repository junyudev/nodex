import { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { NativeImage, Session, WebContents, WebPreferences } from "electron";
import {
  appendMcpAppSandboxInitId,
  buildMcpAppSandboxPartition,
  buildMcpAppSandboxSourceUrl,
  deriveMcpAppSandboxIdentity,
  MCP_APP_SANDBOX_SCHEME,
} from "../../shared/mcp-app/mcp-app-sandbox-contract";
import type { BackendLogger } from "../logging/logger";
import { makeMcpAppSandboxController, type McpAppSandboxPlatform } from "./mcp-app-sandbox-host";

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

it.effect("inline HTML navigation preserves focus without changing ordinary MCP preferences", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sandboxSession = makeSession();
      const owner = Object.assign(new EventEmitter(), { id: 91 }) as unknown as WebContents;
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
    guestEvents.emit("before-input-event", {}, { type: "keyDown", key: " ", isAutoRepeat: false });
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
      Exit.isFailure(yield* Effect.exit(controller.captureImage(owner, sandboxId, "init-fixture"))),
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
      Exit.isFailure(yield* Effect.exit(controller.captureImage(owner, sandboxId, "init-fixture"))),
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
  const owners = [1, 2].map((id) => Object.assign(new EventEmitter(), { id }));
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
    assert.strictEqual((yield* h.controller.clearAppData.pipe(Effect.flip)).reason, "unavailable");
    assert.deepEqual(h.first.state.cleared, []);
  }),
);
