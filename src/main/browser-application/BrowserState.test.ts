import { EventEmitter } from "node:events";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";
import type {
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarTabIdentity,
  BrowserSidebarTabSnapshot,
  BrowserUsePresentationRequest,
} from "../../shared/browser-sidebar";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
} from "../../shared/workbench-scene";
import type { BrowserPageRuntime, BrowserSerializedPage } from "../browser/browser-page-store";
import type { BrowserSidebarEvent } from "../browser/BrowserSidebarEventHub";
import { makeBrowserRuntimeRegistry } from "../browser/browser-runtime-registry";
import { makeBrowserPageEmulationRuntimeUnsafe } from "../browser/browser-page-emulation";
import { makeBrowserEarlyPageRestoreRuntime } from "../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserWebContentsListenerRuntime } from "../browser/BrowserWebContentsListenerRuntime";
import type { BrowserWebContentsLike } from "../platform/electron/BrowserElectronPlatform";
import { BrowserForkTransferError, makeBrowserForkTransfer } from "./BrowserForkTransfer";
import { BrowserState } from "./BrowserState";
import { makeWebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import type { BrowserPermissionStore } from "../browser/browser-permission-store";

const identity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "scope-1",
  browserTabId: "tab-1",
} as const;

class FakeWebContents extends EventEmitter {
  readonly id = 101;
  readonly debugger = {
    attach: () => undefined,
    detach: () => undefined,
    isAttached: () => true,
    sendCommand: async () => undefined,
  };
  readonly loadUrls: string[] = [];
  destroyed = false;
  loading = false;
  title = "New tab";
  url = "about:blank";
  loadPromise: Promise<void> | null = null;
  restorePromise: Promise<void> | null = null;
  restoredHistory: BrowserSerializedPage["navigation"] | null = null;
  historyEntries: BrowserSerializedPage["navigation"]["entries"] = [
    { title: "New tab", url: "about:blank" },
  ];
  historyActiveIndex = 0;
  readonly navigationHistory = {
    clear: () => undefined,
    getActiveIndex: () => this.historyActiveIndex,
    getAllEntries: () => this.historyEntries,
    restore: async (options: {
      entries: BrowserSerializedPage["navigation"]["entries"];
      index?: number;
    }) => {
      if (this.restorePromise) await this.restorePromise;
      const currentIndex = options.index ?? options.entries.length - 1;
      this.restoredHistory = { currentIndex, entries: options.entries };
      this.historyEntries = options.entries;
      this.historyActiveIndex = currentIndex;
      const active = options.entries[currentIndex];
      if (!active) return;
      this.url = active.url;
      this.title = active.title;
    },
  };
  readonly session = {
    fetch: async () =>
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
  };

  canGoBack() {
    return false;
  }
  canGoForward() {
    return false;
  }
  capturePage() {
    return Promise.resolve({ toDataURL: () => "data:image/png;base64,test" });
  }
  executeJavaScript() {
    return Promise.resolve(undefined);
  }
  getTitle() {
    return this.title;
  }
  getURL() {
    return this.url;
  }
  goBack() {}
  goForward() {}
  inspectElement() {}
  isDestroyed() {
    return this.destroyed;
  }
  isLoading() {
    return this.loading;
  }
  loadURL(url: string) {
    this.loadUrls.push(url);
    this.url = url;
    return this.loadPromise ?? Promise.resolve();
  }
  reload() {}
  reloadIgnoringCache() {}
  send() {}
  windowOpenHandler:
    | ((details: { url: string; disposition: string }) => { action: "deny" | "allow" })
    | null = null;
  setWindowOpenHandler(
    handler: (details: { url: string; disposition: string }) => { action: "deny" | "allow" },
  ) {
    this.windowOpenHandler = handler;
  }
  backgroundThrottling = true;
  setBackgroundThrottling(enabled: boolean) {
    this.backgroundThrottling = enabled;
  }
  setZoomFactor() {}
  stop() {}
}

function makeMemoryPages(initial: readonly BrowserSerializedPage[] = []): {
  readonly pages: Map<string, BrowserSerializedPage>;
  readonly runtime: BrowserPageRuntime;
} {
  const pages = new Map(initial.map((page) => [page.browserStorageId, page]));
  return {
    pages,
    runtime: {
      clear: Effect.sync(() => pages.clear()),
      delete: (browserStorageId) => Effect.sync(() => void pages.delete(browserStorageId)),
      get: (browserStorageId) => Effect.sync(() => pages.get(browserStorageId) ?? null),
      reassociate: (sourceStorageId, targetStorageId) =>
        Effect.sync(() => {
          const page = pages.get(sourceStorageId);
          if (!page) return;
          pages.delete(sourceStorageId);
          pages.set(targetStorageId, { ...page, browserStorageId: targetStorageId });
        }),
      set: (page) => Effect.sync(() => void pages.set(page.browserStorageId, page)),
    },
  };
}

const makeFixture = (
  options: {
    readonly contents?: FakeWebContents;
    readonly page?: BrowserSerializedPage;
    readonly permissionStore?: BrowserPermissionStore;
  } = {},
) =>
  Effect.gen(function* () {
    const contents = options.contents ?? new FakeWebContents();
    const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const events: BrowserSidebarEvent[] = [];
    const externalUrls: string[] = [];
    const pages = makeMemoryPages(options.page ? [options.page] : []);
    const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
    const runtimeRegistry = makeBrowserRuntimeRegistry();
    const state = new BrowserState({
      rendererDestruction: yield* makeWebContentsDestructionSubscriptions,
      permissionStore: options.permissionStore,
      earlyPageRestores: yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>(),
      electron: {
        sessionFromPartition: (() => ({
          clearCache: async () => undefined,
          clearData: async () => undefined,
        })) as never,
        openExternal: async (url) => {
          externalUrls.push(url);
        },
        presentContextMenu: () => undefined,
        webContentsFromId: (webContentsId) =>
          webContentsId === contents.id
            ? (contents as unknown as BrowserWebContentsLike)
            : webContentsId === 7
              ? (owner as unknown as BrowserWebContentsLike)
              : null,
      },
      clipboard: { writeImage: () => Effect.void, writeText: () => Effect.void },
      events: { publish: (event) => events.push(event) },
      fork: (effect) => void runBackground(effect),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      pageEmulation: makeBrowserPageEmulationRuntimeUnsafe(),
      pageStore: pages.runtime,
      runtimeRegistry,
      saveBrowserImage: () => {
        throw new Error("Unexpected browser image save");
      },
      siteStatus: { cachedCommentModeBlocked: () => null },
      webContentsListeners: yield* makeBrowserWebContentsListenerRuntime,
    });
    return { contents, owner, events, externalUrls, pages: pages.pages, runtimeRegistry, state };
  });

const registerTab = (state: BrowserState, browserStorageId = "browser:durable") =>
  state.handleCommand({
    type: "register-tab",
    ...identity,
    browserStorageId,
    projectId: "project-1",
    initialUrl: "about:blank",
    title: "Browser",
  });

function readTab(state: BrowserState, tabIdentity: BrowserSidebarTabIdentity = identity) {
  const tab = state
    .getStateSnapshot()
    .tabs.find(
      (candidate) =>
        candidate.browserConversationId === tabIdentity.browserConversationId &&
        candidate.browserViewScopeId === tabIdentity.browserViewScopeId &&
        candidate.browserTabId === tabIdentity.browserTabId,
    );
  if (!tab) throw new Error("Missing Browser tab");
  return tab;
}

const hostCreated = (state: BrowserState, ownerWebContentsId?: number) =>
  state.handleWebviewHostCreated(
    {
      ...identity,
      browserStorageId: "browser:durable",
      projectId: "project-1",
      hostKind: "panel",
      mountGeneration: 2,
      webContentsId: 101,
      initialUrl: "about:blank",
    },
    ownerWebContentsId,
  );

function sourceScene() {
  const empty = materializeInitialWorkbenchScene(
    { kind: "session", sessionId: identity.browserConversationId },
    {
      touchedAt: "2026-07-23T00:00:00.000Z",
      identityFactory: { createId: (kind) => `${kind}:seed` },
    },
  );
  const withTab = createWorkbenchSceneSurface(empty, {
    panelId: "right",
    surface: {
      id: "view-browser",
      kind: "browser",
      titleSnapshot: "Docs",
      config: { browserTabId: identity.browserTabId, url: "https://example.com/fallback" },
      stateKey: 0,
      state: null,
    },
  });
  const visible = patchWorkbenchScenePanel(withTab, "right", { collapsed: false });
  return activateWorkbenchSceneSurface(
    visible,
    "right",
    visible.panels.right.layout.activeLeafId,
    "view-browser",
  );
}

describe("BrowserState semantic capability", () => {
  it.effect("binds durable history to one storage identity and admits direct navigation", () =>
    Effect.gen(function* () {
      const page: BrowserSerializedPage = {
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId: "browser:durable",
        identity,
        title: "Restored",
        url: "https://example.com/restored",
        updatedAt: 1,
        navigation: {
          currentIndex: 0,
          entries: [{ title: "Restored", url: "https://example.com/restored" }],
        },
      };
      const { contents, state } = yield* makeFixture({ page });
      const registered = yield* registerTab(state);
      expect(registered).toMatchObject({
        ok: true,
        snapshot: { browserStorageId: "browser:durable", url: page.url },
      });

      expect(yield* registerTab(state, "browser:forged")).toEqual({
        ok: false,
        message: "Browser storage identity does not match the registered tab",
      });
      expect(
        yield* state.handleCommand({
          type: "navigate",
          ...identity,
          url: "javascript:alert(document.cookie)",
        }),
      ).toMatchObject({ ok: true, snapshot: { url: "javascript:alert(document.cookie)" } });
      assert.deepEqual(contents.loadUrls, []);
    }),
  );

  it.effect("fences a late durable history restore when its guest generation is released", () =>
    Effect.gen(function* () {
      let finishRestore!: () => void;
      const contents = new FakeWebContents();
      contents.restorePromise = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      const page: BrowserSerializedPage = {
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId: "browser:durable",
        identity,
        title: "Restored",
        url: "https://example.com/restored",
        updatedAt: 1,
        navigation: {
          currentIndex: 0,
          entries: [{ title: "Restored", url: "https://example.com/restored" }],
        },
      };
      const { state } = yield* makeFixture({ contents, page });
      yield* registerTab(state);
      state.prepareAttachedWebviewHistoryRestore(
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 2,
        },
        contents.id,
      );
      const attached = yield* Effect.forkChild(hostCreated(state), { startImmediately: true });
      contents.destroyed = true;
      contents.emit("destroyed");
      const released = readTab(state);
      finishRestore();

      expect(yield* Fiber.join(attached)).toEqual({
        ok: false,
        message: "Browser webview was released during history restoration",
      });
      expect(readTab(state)).toEqual(released);
      assert.isNull(readTab(state).webContentsId);
    }),
  );

  it.effect("authorizes a guest only for its exact Electron owner", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      state.registerAttachedWebviewOwnership(7, 101, identity, "browser:durable");

      expect(yield* hostCreated(state, 8)).toEqual({
        ok: false,
        message: "Browser webview does not belong to the requesting window",
      });
      assert.isNull(readTab(state).webContentsId);
      expect(yield* hostCreated(state, 7)).toMatchObject({
        ok: true,
        snapshot: { webContentsId: 101 },
      });
    }),
  );

  it.effect("rejects a presentation sync that no longer owns the physical host generation", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      const context = { ownerWebContentsId: 7 };
      yield* state.handleCommand(
        {
          type: "register-renderer-session",
          browserViewScopeId: identity.browserViewScopeId,
          rendererInstanceId: "renderer-1",
        },
        context,
      );
      yield* state.handleCommand(
        {
          type: "register-host",
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 3,
          hostKind: "retained",
          pagePersistence: "durable",
          themeVariant: "dark",
        },
        context,
      );

      const result = yield* state.handleCommand(
        {
          type: "sync-host",
          ...identity,
          rendererInstanceId: "renderer-1",
          hostGeneration: 2,
          mountGeneration: 3,
          hostKind: "retained",
          presented: false,
          themeVariant: "dark",
          visible: false,
        },
        context,
      );

      expect(result).toMatchObject({ ok: false });
    }),
  );

  it.effect("rejects a late host-created acknowledgement from a superseded presentation", () =>
    Effect.gen(function* () {
      const { runtimeRegistry, state } = yield* makeFixture();
      yield* registerTab(state);
      runtimeRegistry.registerRendererSession({
        browserViewScopeId: identity.browserViewScopeId,
        ownerWebContentsId: 7,
        rendererInstanceId: "renderer-1",
      });
      expect(
        runtimeRegistry.registerHost(7, {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
          hostKind: "retained",
          pagePersistence: "durable",
        }).ok,
      ).toBe(true);
      state.registerAttachedWebviewOwnership(
        7,
        101,
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
        },
        "browser:durable",
      );
      expect(
        runtimeRegistry.registerHost(7, {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 2,
          hostKind: "panel",
          pagePersistence: "durable",
        }).ok,
      ).toBe(true);

      const late = yield* state.handleWebviewHostCreated(
        {
          ...identity,
          browserStorageId: "browser:durable",
          rendererInstanceId: "renderer-1",
          hostGeneration: 1,
          mountGeneration: 1,
          projectId: "project-1",
          hostKind: "retained",
          webContentsId: 101,
          initialUrl: "about:blank",
        },
        7,
      );
      expect(late).toEqual({
        ok: false,
        message: "Browser webview does not belong to the requesting window",
      });
      assert.isNull(readTab(state).webContentsId);

      expect(
        yield* state.handleWebviewHostCreated(
          {
            ...identity,
            browserStorageId: "browser:durable",
            rendererInstanceId: "renderer-1",
            hostGeneration: 1,
            mountGeneration: 2,
            projectId: "project-1",
            hostKind: "panel",
            webContentsId: 101,
            initialUrl: "about:blank",
          },
          7,
        ),
      ).toMatchObject({ ok: true, snapshot: { mountGeneration: 2, webContentsId: 101 } });
    }),
  );

  it.effect("ignores stale destroy acknowledgements and releases the exact mount generation", () =>
    Effect.gen(function* () {
      const { contents, events, state } = yield* makeFixture();
      contents.url = "https://example.com";
      yield* registerTab(state);
      yield* hostCreated(state);
      yield* state.handleCommand({ type: "navigate", ...identity, url: "about:blank" });
      const request = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "destroyWebview" }> =>
          event.kind === "destroyWebview",
      )?.value;
      if (!request) return yield* Effect.die("Missing destroy request");

      yield* state.handleWebviewDestroyed({
        ...identity,
        mountGeneration: 1,
        reason: "reset",
        teardownId: "stale",
        disposition: "destroyed",
        webContentsId: contents.id,
      });
      assert.strictEqual(readTab(state).webContentsId, contents.id);

      yield* state.handleWebviewDestroyed({
        ...(request satisfies BrowserSidebarDestroyWebviewRequest),
        disposition: "destroyed",
        webContentsId: contents.id,
      });
      assert.isNull(readTab(state).webContentsId);
      assert.strictEqual(contents.listenerCount("did-start-loading"), 0);
      assert.strictEqual(contents.listenerCount("destroyed"), 0);
    }),
  );

  it.effect("projects waiting, loading, committed, and settled navigation in causal order", () =>
    Effect.gen(function* () {
      const contents = new FakeWebContents();
      let finishLoad!: () => void;
      contents.loadPromise = new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
      const { state } = yield* makeFixture({ contents });
      yield* registerTab(state);
      yield* hostCreated(state);

      yield* state.handleCommand({ type: "navigate", ...identity, url: "https://example.com" });
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: true });
      contents.loading = true;
      contents.emit("did-start-loading");
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: true });
      contents.url = "https://example.com/";
      contents.emit("did-navigate", {}, contents.url);
      expect(readTab(state)).toMatchObject({ isLoading: true, isWaitingForResponse: false });
      contents.loading = false;
      contents.emit("did-stop-loading");
      expect(readTab(state)).toMatchObject({ isLoading: false, isWaitingForResponse: false });
      finishLoad();
    }),
  );

  it.effect("keeps Browser presentation admission separate from active control", () =>
    Effect.gen(function* () {
      const { events, state } = yield* makeFixture();
      const route = {
        browserConversationId: identity.browserConversationId,
        browserViewScopeId: identity.browserViewScopeId,
        codexSessionId: "thread-1",
        ownerWebContentsId: 7,
        projectId: "project-1",
      };
      yield* state.handleCommand({
        type: "browser-use-upsert-tab",
        tab: {
          ...identity,
          codexSessionId: route.codexSessionId,
          projectId: route.projectId,
          title: "Browser",
          url: "https://example.com",
          webContentsId: null,
          viewport: { width: 1280, height: 720, zoomPercent: 100, presetId: "browser-use" },
          captureActive: true,
          released: false,
          updatedAt: 1,
        },
      });

      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, true);
      const visible = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "browserUsePresentationRequest" }> =>
          event.kind === "browserUsePresentationRequest",
      )?.value;
      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, false);
      const hidden = events.findLast(
        (event): event is Extract<BrowserSidebarEvent, { kind: "browserUsePresentationRequest" }> =>
          event.kind === "browserUsePresentationRequest",
      )?.value;
      assert.isFalse(state.isBrowserVisibleForBrowserUse(route, identity.browserTabId));
      assert.strictEqual(
        state.getBrowserUseStateSnapshot().activeBrowserTabIdsByConversationScope[
          `conversation-1\0scope-1`
        ],
        identity.browserTabId,
      );

      state.setBrowserVisibleForBrowserUse(route, identity.browserTabId, true);
      const current = state.listPendingBrowserUsePresentationRequests(identity.browserViewScopeId);
      state.resolveBrowserUsePresentation({
        ...identity,
        requestId: visible?.requestId ?? "missing",
        outcome: "unavailable",
      });
      expect(state.listPendingBrowserUsePresentationRequests(identity.browserViewScopeId)).toEqual(
        current,
      );
      expect(hidden).toMatchObject({
        visible: false,
      } satisfies Partial<BrowserUsePresentationRequest>);
    }),
  );

  it.effect("scopes presented Browser Use surfaces to their exact Electron owner", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      state.registerAttachedWebviewOwnership(7, 101, identity, "browser:durable");
      yield* hostCreated(state, 7);
      yield* state.handleCommand({
        type: "browser-use-upsert-tab",
        tab: {
          ...identity,
          codexSessionId: "thread-1",
          projectId: "project-1",
          title: "Browser",
          url: "https://example.com",
          webContentsId: 101,
          viewport: { width: 1280, height: 720, zoomPercent: 100, presetId: "browser-use" },
          captureActive: true,
          released: false,
          updatedAt: 1,
        },
      });

      assert.isTrue(state.hasPresentedBrowserUseSurfaceForThread("thread-1", 7));
      assert.isFalse(state.hasPresentedBrowserUseSurfaceForThread("thread-1", 8));
      assert.isTrue(state.hasPresentedBrowserUseSurfaceForThread("thread-1"));
    }),
  );

  it.effect("releases physical guest listeners with the owning Scope", () =>
    Effect.gen(function* () {
      const parent = yield* Scope.Scope;
      const scope = yield* Scope.fork(parent);
      const fixture = yield* makeFixture().pipe(Scope.provide(scope));
      yield* registerTab(fixture.state);
      yield* hostCreated(fixture.state);
      assert.isAbove(fixture.contents.listenerCount("destroyed"), 0);

      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(fixture.contents.listenerCount("destroyed"), 0);
      assert.strictEqual(fixture.contents.listenerCount("did-start-loading"), 0);
    }),
  );

  it.effect("captures the initiating scene and remints Browser identities for a fork", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      yield* registerTab(state);
      const transfer = makeBrowserForkTransfer(state);
      const captured = yield* transfer.capture(identity.browserConversationId, {
        browserViewScopeId: identity.browserViewScopeId,
        scene: sourceScene(),
      });
      const rebased = yield* transfer.rebase(captured, "session-target");
      const applied = yield* transfer.apply(rebased, {
        targetBrowserConversationId: "session-target",
        targetBrowserViewScopeId: "window-target",
        targetProjectSession: { id: "session-target", projectId: "project-target" },
      });

      expect(captured.tabs).toMatchObject([
        {
          active: true,
          browserTabId: identity.browserTabId,
          panel: "right",
          tabId: "view-browser",
        },
      ]);
      assert.notEqual(applied.tabs[0]?.browserTabId, identity.browserTabId);
      assert.notEqual(applied.tabs[0]?.tabId, "view-browser");
      expect(state.getStateSnapshot().tabs).toContainEqual(
        expect.objectContaining({
          browserConversationId: "session-target",
          browserViewScopeId: "window-target",
          browserTabId: applied.tabs[0]?.browserTabId,
          projectId: "project-target",
        }),
      );
    }),
  );

  it.effect(
    "retains full view with Chat selected while capturing and applying a Browser fork",
    () =>
      Effect.gen(function* () {
        const { state } = yield* makeFixture();
        const transfer = makeBrowserForkTransfer(state);
        const captured = yield* transfer.capture(identity.browserConversationId, {
          browserViewScopeId: identity.browserViewScopeId,
          scene: patchWorkbenchScenePanel(sourceScene(), "right", {
            collapsed: true,
            size: { fullWidth: true },
          }),
        });
        const rebased = yield* transfer.rebase(captured, "session-target");
        const applied = yield* transfer.apply(rebased, {
          targetBrowserConversationId: "session-target",
          targetBrowserViewScopeId: "window-target",
          targetProjectSession: { id: "session-target", projectId: "project-target" },
        });
        expect(captured).toMatchObject({ rightPanelOpen: false, rightPanelFullWidth: true });
        expect(applied).toMatchObject({ rightPanelOpen: false, rightPanelFullWidth: true });
      }),
  );

  it.effect("rejects a fork whose resolved Browser and Project Session identities diverge", () =>
    Effect.gen(function* () {
      const { state } = yield* makeFixture();
      const transfer = makeBrowserForkTransfer(state);
      const captured = yield* transfer.capture(identity.browserConversationId);
      const error = yield* Effect.flip(
        transfer.apply(captured, {
          targetBrowserConversationId: "session-target",
          targetBrowserViewScopeId: "window-target",
          targetProjectSession: { id: "session-target", projectId: "project-target" },
        }),
      );

      assert.instanceOf(error, BrowserForkTransferError);
      assert.strictEqual(error.targetBrowserConversationId, identity.browserConversationId);
      assert.strictEqual(error.targetProjectSessionId, "session-target");
    }),
  );
});

describe("Browser entry-point navigation policies", () => {
  it.effect("loads direct manual file, data and credentialed URLs without address searches", () =>
    Effect.gen(function* () {
      const { state, contents } = yield* makeFixture();
      yield* registerTab(state);
      yield* hostCreated(state);
      for (const url of [
        "file:///tmp/index.html",
        "data:text/html,Hello",
        "https://user:secret@example.com/private",
        `data:text/html,${"x".repeat(80_000)}`,
      ]) {
        const result = yield* state.handleCommand({ type: "navigate", ...identity, url });
        assert.isTrue(result.ok);
        yield* Effect.yieldNow;
        expect(contents.loadUrls.at(-1)).toBe(url);
        for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
          let prevented = false;
          contents.emit(name, {
            url,
            isMainFrame: true,
            preventDefault: () => {
              prevented = true;
            },
          });
          assert.isFalse(prevented);
        }
      }
    }),
  );

  it.effect("restricts Agent page hooks and subframes only for the control lifetime", () =>
    Effect.gen(function* () {
      const { state, contents } = yield* makeFixture();
      yield* registerTab(state);
      yield* hostCreated(state);
      const blocked: Array<{ url: string; resourceType: string }> = [];
      const unsubscribe = state.subscribeNavigationBlocked((event) => blocked.push(event));
      state.upsertBrowserUseTab({
        ...readTab(state),
        codexSessionId: "session-1",
        captureActive: false,
        released: false,
      });
      for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
        let prevented = false;
        contents.emit(name, {
          url: "file:///tmp/private",
          isMainFrame: true,
          preventDefault: () => {
            prevented = true;
          },
        });
        assert.isTrue(prevented);
      }
      assert.isTrue(
        state.isRestrictedBrowserNavigation(contents.id, "file:///tmp/private", "subFrame"),
      );
      for (const url of ["data:text/html,Frame", "about:blank", "about:srcdoc"]) {
        assert.isFalse(state.isRestrictedBrowserNavigation(contents.id, url, "subFrame"));
        let prevented = false;
        contents.emit("will-redirect", {
          url,
          isMainFrame: false,
          preventDefault: () => {
            prevented = true;
          },
        });
        assert.isFalse(prevented);
      }
      assert.isTrue(
        state.isRestrictedBrowserNavigation(contents.id, "data:text/html,Main", "mainFrame"),
      );
      expect(blocked).toContainEqual(
        expect.objectContaining({ url: "file:///tmp/private", resourceType: "subFrame" }),
      );
      state.releaseBrowserUseTab(identity);
      assert.isFalse(
        state.isRestrictedBrowserNavigation(contents.id, "file:///tmp/private", "subFrame"),
      );
      let prevented = false;
      contents.emit("will-redirect", {
        url: "file:///tmp/private",
        isMainFrame: true,
        preventDefault: () => {
          prevented = true;
        },
      });
      assert.isFalse(prevented);
      unsubscribe();
    }),
  );

  it.effect("enforces Agent policy during guest attachment before renderer acknowledgement", () =>
    Effect.gen(function* () {
      const { state, contents } = yield* makeFixture();
      yield* registerTab(state);
      state.upsertBrowserUseTab({
        ...readTab(state),
        codexSessionId: "session-1",
        captureActive: false,
        released: false,
      });
      state.registerAttachedWebviewOwnership(42, contents.id, identity, "browser:durable");
      assert.isTrue(
        state.isRestrictedBrowserNavigation(contents.id, "file:///tmp/private", "subFrame"),
      );
      let prevented = false;
      contents.emit("will-frame-navigate", {
        url: "file:///tmp/private",
        isMainFrame: false,
        preventDefault: () => {
          prevented = true;
        },
      });
      assert.isTrue(prevented);
      state.releaseBrowserUseTab(identity);
      assert.isFalse(
        state.isRestrictedBrowserNavigation(contents.id, "file:///tmp/private", "subFrame"),
      );
    }),
  );

  it.effect("restores manual navigation history without quarantining its schemes", () =>
    Effect.gen(function* () {
      const entries = [
        "file:///tmp/index.html",
        "data:text/html,Hello",
        "https://user:secret@example.com/private",
      ].map((url) => ({ url, title: url }));
      const page: BrowserSerializedPage = {
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId: "browser:durable",
        identity,
        title: "Local",
        url: entries[0]!.url,
        updatedAt: 1,
        navigation: { currentIndex: 0, entries },
      };
      const { state, contents, pages } = yield* makeFixture({ page });
      yield* registerTab(state);
      yield* hostCreated(state);
      expect(contents.restoredHistory).toEqual(page.navigation);
      expect(pages.get("browser:durable")?.navigation.entries).toEqual(entries);
    }),
  );

  it.effect("rejects Agent control of a currently loaded file page", () =>
    Effect.gen(function* () {
      const { state, contents } = yield* makeFixture();
      yield* registerTab(state);
      yield* hostCreated(state);
      contents.url = "file:///tmp/index.html";
      expect(() =>
        state.upsertBrowserUseTab({
          ...readTab(state),
          codexSessionId: "session-1",
          captureActive: false,
          released: false,
        }),
      ).toThrow("Browser Use URL policy");
      assert.isFalse(state.isRestrictedBrowserNavigation(contents.id, "file:///tmp/index.html"));
    }),
  );

  it.effect("opens popup dispositions through the opener's Browser tab request", () =>
    Effect.gen(function* () {
      const { state, contents, events, externalUrls } = yield* makeFixture();
      yield* registerTab(state);
      state.registerAttachedWebviewOwnership(42, contents.id, identity, "browser:durable");
      yield* hostCreated(state);
      for (const disposition of [
        "other",
        "background-tab",
        "foreground-tab",
        "new-window",
        "default",
      ]) {
        events.length = 0;
        expect(
          contents.windowOpenHandler?.({ url: "file:///tmp/popup.html", disposition }),
        ).toEqual({ action: "deny" });
        const requests = events.filter((event) => event.kind === "openNewTab");
        if (disposition === "other") {
          expect(requests).toEqual([]);
          continue;
        }
        expect(requests).toEqual([
          {
            kind: "openNewTab",
            value: {
              ...identity,
              url: "file:///tmp/popup.html",
              background: disposition === "background-tab",
            },
          },
        ]);
      }
      expect(externalUrls).toEqual([]);
      contents.url = "https://example.com/";
      state.upsertBrowserUseTab({
        ...readTab(state),
        codexSessionId: "session-1",
        captureActive: false,
        released: false,
      });
      events.length = 0;
      contents.windowOpenHandler?.({
        url: "file:///tmp/popup.html",
        disposition: "foreground-tab",
      });
      expect(events.filter((event) => event.kind === "openNewTab")).toEqual([]);
    }),
  );

  it.effect("routes Browser chrome surfaces and throttles local pages by visibility", () =>
    Effect.gen(function* () {
      const { state, contents, events } = yield* makeFixture();
      yield* registerTab(state);
      yield* hostCreated(state);
      for (const surface of ["downloads", "history"] as const) {
        const result = yield* state.handleCommand({
          type: "navigate",
          ...identity,
          url: `chrome://${surface}`,
        });
        assert.isTrue(result.ok);
        expect(events.at(-1)).toEqual({
          kind: "openNewTab",
          value: {
            ...identity,
            url: `chrome://${surface}`,
            background: false,
            browserSurface: surface,
          },
        });
      }
      yield* state.handleCommand({ type: "navigate", ...identity, url: "file:///tmp/index.html" });
      assert.isFalse(contents.backgroundThrottling);
      yield* state.handleCommand({ type: "navigate", ...identity, url: "https://example.com/" });
      assert.isTrue(contents.backgroundThrottling);
    }),
  );

  it.effect(
    "scopes error-page external opening to the current failure and narrower URL policy",
    () =>
      Effect.gen(function* () {
        const { state, contents, externalUrls } = yield* makeFixture();
        yield* registerTab(state);
        yield* hostCreated(state);
        for (const [url, allowed] of [
          ["https://example.com/failure", true],
          ["http://localhost:3000/failure", true],
          ["http://example.com/failure", false],
          ["file:///tmp/failure", false],
        ] as const) {
          contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", url, true);
          const result = yield* state.handleCommand({
            type: "open-external",
            ...identity,
            fromErrorPage: true,
          });
          expect(result.ok).toBe(allowed);
        }
        expect(externalUrls).toEqual([
          "https://example.com/failure",
          "http://localhost:3000/failure",
        ]);
        expect(
          yield* state.handleCommand({
            type: "open-external",
            ...identity,
            fromErrorPage: true,
            url: "https://stale.example/",
          }),
        ).toMatchObject({ ok: false });
      }),
  );
});

const permissionFixture = Effect.gen(function* () {
  const fixture = yield* makeFixture();
  const { state, runtimeRegistry, contents } = fixture;
  yield* registerTab(state);
  const route = {
    ...identity,
    browserStorageId: "browser:durable",
    rendererInstanceId: "permission-renderer",
    hostGeneration: 1,
    mountGeneration: 2,
  };
  runtimeRegistry.registerRendererSession({
    browserViewScopeId: identity.browserViewScopeId,
    ownerWebContentsId: 7,
    rendererInstanceId: route.rendererInstanceId,
  });
  const registered = runtimeRegistry.registerHost(7, {
    ...route,
    hostKind: "panel",
    pagePersistence: "durable",
  });
  assert.isTrue(registered.ok);
  const admission = state.authorizeWebviewAttachment(7, route);
  if (!admission.ok) throw new Error("Permission guest admission failed");
  state.consumeAuthorizedWebviewAttachment(admission.authorization.attachToken, 7, contents.id);
  state.registerAttachedWebviewOwnership(7, contents.id, route, route.browserStorageId);
  yield* state.handleWebviewHostCreated(
    {
      ...route,
      projectId: "project-1",
      hostKind: "panel",
      webContentsId: contents.id,
      initialUrl: "https://example.com/page",
    },
    7,
  );
  contents.url = "https://example.com/page";
  contents.emit("did-navigate", {}, contents.url);
  const results: boolean[] = [];
  const request = () =>
    state.permissions.request(
      contents as never,
      "notifications",
      (allowed) => results.push(allowed),
      { requestingUrl: contents.url, isMainFrame: true },
    );
  return { ...fixture, results, request, route };
});

describe("Browser permission presentation lifetime", () => {
  it.effect("publishes prompts through the tab snapshot and accepts only its presented owner", () =>
    Effect.gen(function* () {
      const { state, request, results, events } = yield* permissionFixture;
      request();
      const prompt = readTab(state).permissionPrompts?.[0];
      if (!prompt) throw new Error("Missing Browser prompt snapshot");
      assert.isTrue(
        events.some(
          (event) =>
            event.kind === "state" &&
            event.value.tabs.some((tab) =>
              tab.permissionPrompts?.some((value) => value.id === prompt.id),
            ),
        ),
      );
      const command = {
        ...identity,
        type: "respond-permission" as const,
        promptId: prompt.id,
        mountGeneration: prompt.mountGeneration,
        action: "allow-this-time" as const,
      };
      assert.isFalse((yield* state.handleCommand(command, { ownerWebContentsId: 8 })).ok);
      assert.isEmpty(results);
      assert.isTrue((yield* state.handleCommand(command, { ownerWebContentsId: 7 })).ok);
      assert.deepEqual(results, [true]);
      assert.isEmpty(readTab(state).permissionPrompts);
    }),
  );

  for (const end of [
    "navigation",
    "same-url-reload",
    "close",
    "renderer-loss",
    "guest-loss",
    "renderer-replaced",
    "owner-destroyed",
    "owner-reload",
  ] as const) {
    it.effect(`dismisses the Electron callback on ${end}`, () =>
      Effect.gen(function* () {
        const { state, request, results, contents, owner } = yield* permissionFixture;
        request();
        const prompt = readTab(state).permissionPrompts?.[0];
        if (!prompt) throw new Error("Missing Browser prompt snapshot");
        if (end === "navigation")
          contents.emit("did-start-navigation", {}, "https://other.example/", false, true);
        if (end === "same-url-reload")
          contents.emit("did-start-navigation", {}, contents.url, false, true);
        if (end === "close") yield* state.handleCommand({ ...identity, type: "close-tab" });
        if (end === "renderer-loss") owner.emit("render-process-gone");
        if (end === "owner-destroyed") owner.emit("destroyed");
        if (end === "owner-reload")
          owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        if (end === "guest-loss") contents.emit("render-process-gone", {}, { reason: "crashed" });
        if (end === "renderer-replaced")
          yield* state.handleCommand(
            {
              type: "register-renderer-session",
              browserViewScopeId: identity.browserViewScopeId,
              rendererInstanceId: "replacement",
            },
            { ownerWebContentsId: 7 },
          );
        assert.deepEqual(results, [false]);
        const result = yield* state.handleCommand(
          {
            ...identity,
            type: "respond-permission",
            promptId: prompt.id,
            mountGeneration: prompt.mountGeneration,
            action: "allow-this-time",
          },
          { ownerWebContentsId: 7 },
        );
        assert.isFalse(result.ok);
      }),
    );
  }
});

it.effect("resets only the current presented origin under its renderer owner", () =>
  Effect.gen(function* () {
    const fixture = yield* permissionFixture;
    const command = {
      ...identity,
      type: "reset-site-permissions" as const,
      origin: "https://example.com",
    };
    assert.isFalse((yield* fixture.state.handleCommand(command, { ownerWebContentsId: 8 })).ok);
    assert.isFalse(
      (yield* fixture.state.handleCommand(
        { ...command, origin: "https://foreign.example" },
        { ownerWebContentsId: 7 },
      )).ok,
    );
    fixture.request();
    assert.isTrue((yield* fixture.state.handleCommand(command, { ownerWebContentsId: 7 })).ok);
    assert.deepEqual(fixture.results, [false]);
    assert.isEmpty(readTab(fixture.state).permissionPrompts);
  }),
);

it.effect("uses native input activation for clipboard writes and clears it on navigation", () =>
  Effect.gen(function* () {
    const { contents, state } = yield* permissionFixture;
    const results: boolean[] = [];
    const request = () =>
      state.permissions.request(
        contents as never,
        "clipboard-sanitized-write",
        (allowed) => results.push(allowed),
        { isMainFrame: true, requestingUrl: contents.url },
      );
    contents.emit("before-mouse-event", {}, { type: "mouseMove" });
    request();
    assert.isEmpty(results);
    state.permissions.release(contents.id);
    contents.emit("before-mouse-event", {}, { type: "mouseDown" });
    request();
    assert.deepEqual(results, [false, true]);
    contents.emit("did-start-navigation", {}, contents.url, false, true);
    request();
    assert.lengthOf(results, 2);
    state.permissions.dispose();
  }),
);

it.effect("uses native page liveness after a crashed page reloads", () =>
  Effect.gen(function* () {
    const { state, contents, request, results } = yield* permissionFixture;
    let crashed = true;
    Object.assign(contents, { isCrashed: () => crashed });
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    request();
    assert.deepEqual(results, [false]);
    crashed = false;
    contents.emit("did-navigate", {}, contents.url);
    request();
    assert.lengthOf(results, 1);
    assert.lengthOf(readTab(state).permissionPrompts ?? [], 1);
    state.permissions.dispose();
  }),
);
